import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFeed } from "../src/protobuf.js";
import { predictionsFrom, vehiclesFrom } from "../src/realtime.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.pb`, import.meta.url));

// Tiny protobuf encoder for hand-made buffers.
const varint = (n) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    out.push(Number(v & 0x7fn) | (v > 0x7fn ? 0x80 : 0));
    v >>= 7n;
  } while (v);
  return out;
};
const key = (field, wire) => varint((field << 3) | wire);
const vint = (field, n) => [...key(field, 0), ...varint(n)];
const bytes = (field, data) => [...key(field, 2), ...varint(data.length), ...data];
const str = (field, s) => bytes(field, [...new TextEncoder().encode(s)]);
const float = (field, x) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x);
  return [...key(field, 5), ...b];
};
const fixed64 = (field) => [...key(field, 1), 1, 2, 3, 4, 5, 6, 7, 8];

test("decodes the vehicle-positions fixture", () => {
  const feed = decodeFeed(fixture("vehicle-positions"));
  assert.ok(feed.header.timestamp > 1.7e9);
  assert.ok(feed.entity.length > 50);
  const { feedTimestamp, vehicles } = vehiclesFrom(feed, feed.header.timestamp);
  assert.equal(feedTimestamp, feed.header.timestamp);
  assert.ok(vehicles.length > 50);
  for (const v of vehicles) {
    assert.ok(v.id && typeof v.tripId === "string" && typeof v.routeId === "string");
    assert.ok(v.lat > 40.7 && v.lat < 41.1 && v.lon > 14 && v.lon < 14.5, `${v.lat},${v.lon}`);
    assert.ok(v.bearing === null || (v.bearing >= 0 && v.bearing <= 360));
    assert.ok(v.ageSec >= 0 && v.ageSec <= 90);
  }
  assert.equal(vehiclesFrom(feed, feed.header.timestamp + 3600).vehicles.length, 0, "stale vehicles are dropped");
});

test("decodes the trip-updates fixture", () => {
  const feed = decodeFeed(fixture("trip-updates"));
  const stops = feed.entity.flatMap((e) => e.tripUpdate?.stopTimeUpdate || []);
  assert.ok(stops.some((s) => s.scheduleRelationship === "NO_DATA"));
  const map = predictionsFrom(feed);
  assert.ok(map.size > 100);
  for (const [k, p] of map) {
    assert.match(k, /^.+\|.+$/);
    assert.ok(Number.isInteger(p.time) && Math.abs(p.time - feed.header.timestamp) < 86400 * 2);
    assert.ok(p.delaySec === null || Number.isInteger(p.delaySec));
  }
});

test("hand-made feed: shapes, enums, negatives, unknown fields, fixed64 skip", () => {
  const position = [...float(1, 40.85), ...float(2, 14.25), ...fixed64(4), ...float(5, 10)];
  const vehicle = [
    ...bytes(1, [...str(1, "T1"), ...str(2, "08:00:00"), ...str(5, "R1")]),
    ...bytes(2, position),
    ...vint(4, 2), // current_status, not read
    ...vint(5, 1_700_000_000),
    ...bytes(8, [...str(1, "V1"), ...str(2, "label")]),
  ];
  const stu = (rel, delay) => [
    ...vint(1, 7),
    ...bytes(2, [...vint(1, delay), ...vint(2, 1_700_000_100), ...vint(3, 30)]),
    ...str(4, "S1"),
    ...(rel === undefined ? [] : vint(5, rel)),
  ];
  const tripUpdate = [...bytes(1, str(1, "T1")), ...bytes(2, stu(undefined, -120)), ...bytes(2, stu(2, 5)), ...bytes(2, stu(9, 0))];
  const buf = Buffer.from([
    ...bytes(1, [...str(1, "2.0"), ...vint(2, 0), ...vint(3, 1_700_000_050), ...fixed64(99)]),
    ...bytes(2, [...str(1, "e1"), ...vint(2, 0), ...bytes(4, vehicle)]),
    ...bytes(2, [...str(1, "e2"), ...bytes(3, tripUpdate), ...bytes(5, str(1, "alert ignored"))]),
    ...fixed64(15),
    ...float(16, 1),
  ]);
  const feed = decodeFeed(buf);
  assert.deepEqual(feed.header, { timestamp: 1_700_000_050 });
  assert.equal(feed.entity[0].id, "e1");
  assert.equal(feed.entity[0].vehicle.position.latitude, Math.fround(40.85));
  assert.deepEqual(feed.entity[0].vehicle.trip, { tripId: "T1", routeId: "R1" });
  assert.deepEqual(feed.entity[0].vehicle.vehicle, { id: "V1" });
  assert.equal(Object.hasOwn(feed.entity[0].vehicle.position, "bearing"), false, "absent fields stay absent");
  const stops = feed.entity[1].tripUpdate.stopTimeUpdate;
  assert.deepEqual(
    stops.map((s) => [s.arrival.delay, s.scheduleRelationship]),
    [[-120, undefined], [5, "NO_DATA"], [0, 9]],
  );
  assert.equal(stops[0].arrival.time, 1_700_000_100);

  assert.deepEqual(vehiclesFrom(feed, 1_700_000_010), {
    feedTimestamp: 1_700_000_050,
    vehicles: [
      { id: "V1", tripId: "T1", routeId: "R1", lat: Math.fround(40.85), lon: 14.25, bearing: null, speedKmh: 36, ageSec: 10 },
    ],
  });
  assert.deepEqual(
    [...predictionsFrom(feed)],
    [["T1|S1", { time: 1_700_000_100, delaySec: 0 }]],
    "NO_DATA skipped, later stop with same key wins",
  );
});

test("rejects truncated or unsupported input", () => {
  assert.throws(() => decodeFeed(Buffer.from([0x0a, 0x05, 0x01])), /truncated/);
  assert.throws(() => decodeFeed(Buffer.from([0x08, 0x80])), /truncated/);
  assert.throws(() => decodeFeed(Buffer.from([0x0b])), /wire type 3/);
  assert.deepEqual(decodeFeed(new Uint8Array()), {});
});
