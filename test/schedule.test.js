import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { linkFsStops, mapStops, setDatabase, suggest } from "../src/schedule.js";

// Same tables as src/ingest.js (only the ones schedule.js reads in these tests).
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE routes (feed TEXT NOT NULL, route_id TEXT NOT NULL, agency_id TEXT, short_name TEXT, long_name TEXT,
    route_type INTEGER, color TEXT, operator TEXT, PRIMARY KEY (feed, route_id));
  CREATE TABLE stops (feed TEXT NOT NULL, stop_id TEXT NOT NULL, name TEXT, name_key TEXT, lat REAL, lon REAL,
    operator TEXT, kind INTEGER, PRIMARY KEY (feed, stop_id));
  CREATE TABLE trips (feed TEXT NOT NULL, trip_id TEXT NOT NULL, route_id TEXT, service_id TEXT, headsign TEXT,
    direction TEXT, PRIMARY KEY (feed, trip_id));
  CREATE TABLE stop_times (feed TEXT NOT NULL, trip_id TEXT NOT NULL, stop_id TEXT NOT NULL, dep_sec INTEGER NOT NULL, seq INTEGER);
  CREATE TABLE service_dates (feed TEXT NOT NULL, service_id TEXT NOT NULL, ymd TEXT NOT NULL);
  CREATE TABLE patterns (feed TEXT NOT NULL, route_id TEXT NOT NULL, direction TEXT NOT NULL, trip_id TEXT NOT NULL,
    headsign TEXT, nstops INTEGER, shape_id TEXT);
  CREATE TABLE shapes (feed TEXT NOT NULL, shape_id TEXT NOT NULL, points TEXT NOT NULL, PRIMARY KEY (feed, shape_id));

  INSERT INTO routes VALUES
    ('eav', 'NS', 'EAV', 'NS', 'Napoli - Pompei Scavi - Sorrento', 2, 'ff0000', 'eav-rail'),
    ('eav', 'B1', 'EAV', 'B1', 'Pompei Scavi - Castellammare', 3, '', 'eav-bus'),
    ('anm', 'R2', 'ANM', 'R2', 'Garibaldi - Municipio', 3, '', 'anm'),
    ('anm', '151', 'ANM', '151', 'Garibaldi - Pozzuoli', 3, '', 'anm');
  INSERT INTO stops VALUES
    ('eav', 'P1', 'Pompei Scavi', 'POMPEISCAVI', 40.7498, 14.4857, 'eav-rail', 2),
    ('anm', 'G1', 'Garibaldi', 'GARIBALDI', 40.8530, 14.2720, 'anm', 3),
    ('anm', 'G2', 'Garibaldi', 'GARIBALDI', 40.8531, 14.2722, 'anm', 3),
    ('anm', 'FS1', 'Napoli P. Garibaldi', 'NAPOLIPGARIBALDI', 40.8527, 14.2725, 'fs', 2),
    ('anm', 'FS2', 'Napoli P. Garibaldi', 'NAPOLIPGARIBALDI', 40.8527, 14.2726, 'fs', 2);
  INSERT INTO trips VALUES
    ('eav', 'T1', 'NS', 'S', 'Sorrento', '0'),
    ('anm', 'T2', 'R2', 'S', 'Municipio', '0'),
    ('anm', 'T3', '151', 'S', 'Pozzuoli', '0');
  INSERT INTO stop_times VALUES
    ('eav', 'T1', 'P1', 36000, 1),
    ('anm', 'T2', 'G1', 36000, 1),
    ('anm', 'T3', 'G2', 36060, 1);
`);
setDatabase(db);

test("multi-word query matches route long names", () => {
  const { routes } = suggest("pompei scavi");
  assert.deepEqual(routes.map((route) => route.id), ["B1", "NS"]);
});

test("operator filter restricts routes and stops", () => {
  const { routes, stops } = suggest("pompei scavi", "eav-rail");
  assert.deepEqual(routes.map((route) => route.id), ["NS"]);
  assert.deepEqual(stops.map((stop) => stop.operator), ["eav-rail"]);
  assert.equal(suggest("garibaldi", "eav-rail").stops.length, 0);
});

test("suggest groups nearby stops and lists their lines", () => {
  const { stops } = suggest("garibaldi", "anm");
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].ids, ["G1", "G2"]);
  assert.deepEqual(stops[0].lines, ["151", "R2"]);
  assert.deepEqual(suggest("pompei").stops[0].lines, ["NS"]);
});

test("linkFsStops groups FS stops and is cached", () => {
  const linked = linkFsStops();
  assert.equal(linked.length, 1);
  assert.deepEqual(linked[0].ids, ["FS1", "FS2"]);
  assert.equal(linked[0].fsCode, "S09109");
  assert.equal(linkFsStops(), linked);
});

test("mapStops returns the compact layer shape", () => {
  const bus = mapStops("bus");
  assert.equal(bus.length, 2);
  assert.deepEqual(bus.find((stop) => stop.i === "G1"), { l: ["R2"], f: "anm", i: "G1", n: "Garibaldi", y: 40.853, x: 14.272, o: "anm", k: 3 });
  assert.deepEqual(mapStops("rail").map((stop) => stop.i).sort(), ["FS1", "FS2", "P1"]);
});
