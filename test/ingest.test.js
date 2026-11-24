import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/csv.js";
import { crc32 } from "node:zlib";
import { serviceDates, tailFingerprint, zipFingerprint } from "../src/ingest.js";
import { readZip } from "../src/zip.js";

/** Minimal stored (method 0) ZIP: [name, text, dosTime?] entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, time = 0] of entries) {
    const data = Buffer.from(text);
    const fileName = Buffer.from(name);
    const fields = (header) => {
      header.writeUInt16LE(time, header.length === 30 ? 10 : 12);
      header.writeUInt32LE(crc32(data), header.length === 30 ? 14 : 16);
      header.writeUInt32LE(data.length, header.length === 30 ? 18 : 20);
      header.writeUInt32LE(data.length, header.length === 30 ? 22 : 24);
      header.writeUInt16LE(fileName.length, header.length === 30 ? 26 : 28);
      return header;
    };
    const local = fields(Buffer.alloc(30));
    local.writeUInt32LE(0x04034b50, 0);
    const central = fields(Buffer.alloc(46));
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const big = "x".repeat(5000);
const feed = (stops, time, extra = "readme") => makeZip([["gtfs/stop_times.txt", big], ["stops.txt", stops, time], ["notes.txt", extra]]);
const tail = (zip, size) => ({ buf: zip.subarray(zip.length - size), range: `bytes ${zip.length - size}-${zip.length - 1}/${zip.length}` });

test("zip fingerprint: the tail of the zip gives the same fingerprint as the whole file", () => {
  const zip = feed("stop_id\nA\n");
  assert.equal(readZip(zip, new Set(["stops.txt"])).get("stops.txt").toString(), "stop_id\nA\n");
  const { buf, range } = tail(zip, 300);
  assert.match(zipFingerprint(zip), /^[0-9a-f]{40}$/);
  assert.equal(tailFingerprint(buf, range), zipFingerprint(zip));
});

test("zip fingerprint: changes with wanted file content, ignores mtimes and unrelated files", () => {
  const base = zipFingerprint(feed("stop_id\nA\n"));
  assert.notEqual(zipFingerprint(feed("stop_id\nB\n")), base);
  assert.equal(zipFingerprint(feed("stop_id\nA\n", 0x5d78)), base);
  assert.equal(zipFingerprint(feed("stop_id\nA\n", 0, "other")), base);
});

test("zip fingerprint: ambiguous tails give null so the full zip is downloaded", () => {
  const zip = feed("stop_id\nA\n");
  const short = tail(zip, 100); // central directory starts before the tail
  assert.equal(tailFingerprint(short.buf, short.range), null);
  const { buf } = tail(zip, 300);
  assert.equal(tailFingerprint(buf, `bytes 0-299/${zip.length}`), null); // not the end of the file
  assert.equal(tailFingerprint(buf, null), null);
  assert.equal(tailFingerprint(Buffer.from("<html>errore</html>"), "bytes 0-18/19"), null);
});

const rows = (text) => parseCsv(Buffer.from(text, "utf8"));

test("csv: header, BOM, CRLF, blank lines", () => {
  assert.deepEqual(rows("﻿a, b\r\n1,2\r\n\r\n\n3,4"), [
    { a: "1", b: "2" },
    { a: "3", b: "4" },
  ]);
});

test("csv: quoted commas, doubled quotes, newlines inside quotes", () => {
  assert.deepEqual(rows('id,name\n1,"Piazza, Garibaldi"\n2,"Via ""Toledo"""\n3,"a\nb"\n'), [
    { id: "1", name: "Piazza, Garibaldi" },
    { id: "2", name: 'Via "Toledo"' },
    { id: "3", name: "a\nb" },
  ]);
});

test("csv: mid-field quotes, empty fields, missing cells, lone CR, unterminated quote", () => {
  assert.deepEqual(rows('a,b,c\nx"y,z"w,\n,1\r"",2,3\r"open,end'), [
    { a: "xy,zw", b: "", c: "" },
    { a: "", b: "1", c: "" },
    { a: "", b: "2", c: "3" },
    { a: "open,end", b: "", c: "" },
  ]);
});

test("calendar: weekday expansion plus calendar_dates exceptions", () => {
  const calendar = [
    // 2026-11-23 is a Monday: weekdays only, two weeks
    { service_id: "FER", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20261123", end_date: "20261206" },
    { service_id: "BAD", monday: "1", start_date: "", end_date: "20261206" },
  ];
  const exceptions = [
    { service_id: "FER", date: "20261125", exception_type: "2" }, // removed
    { service_id: "FER", date: "20261129", exception_type: "1" }, // added Sunday
    { service_id: "EXTRA", date: "20261208", exception_type: "1" }, // calendar_dates only
    { service_id: "NONE", date: "20261208", exception_type: "2" }, // removing from unknown service is a no-op
  ];
  const dates = serviceDates(calendar, exceptions);
  assert.deepEqual([...dates.get("FER")].sort(), [
    "20261123", "20261124", "20261126", "20261127", "20261129",
    "20261130", "20261201", "20261202", "20261203", "20261204",
  ]);
  assert.deepEqual([...dates.get("EXTRA")], ["20261208"]);
  assert.equal(dates.has("BAD"), false);
  assert.equal(dates.has("NONE"), false);
});

test("calendar: crosses month/year and DST boundaries", () => {
  const all = { monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1" };
  const dates = serviceDates([{ service_id: "S", ...all, start_date: "20261230", end_date: "20270102" }, { service_id: "D", ...all, start_date: "20270327", end_date: "20270329" }], []);
  assert.deepEqual([...dates.get("S")], ["20261230", "20261231", "20270101", "20270102"]);
  assert.deepEqual([...dates.get("D")], ["20270327", "20270328", "20270329"]);
});
