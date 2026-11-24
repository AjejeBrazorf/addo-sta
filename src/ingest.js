import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { iterateCsv, parseCsv } from "./csv.js";
import { nameKey } from "./places.js";
import { centralDirectory, readZip } from "./zip.js";

const UA = "AddoSta/1.0 (orari aperti EAV e ANM; contatto locale)";
const WANTED = new Set(["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "shapes.txt"]);
const OPTIONAL = new Set(["calendar.txt", "calendar_dates.txt"]); // at least one of the two, checked in build()
const SCHEMA = 3;

const FEEDS = [
  {
    id: "eav",
    url: "https://www.wimob.it/cfile/download.php?file=google-transit.zip",
    page: "https://www.eavsrl.it/open-data/",
    operators: {
      NA0004: "eav-rail",
      EAVO: "eav-bus",
    },
  },
  {
    id: "anm",
    url: "https://www.anm.it/google/google-transit.zip",
    page: "https://www.transit.land/data/feeds/f-s-anm~it",
    operators: {
      ANM: "anm",
      FS: "fs",
    },
  },
];

const TYPE_RANK = { 1: 0, 2: 1, 7: 2, 0: 3, 11: 4, 3: 5 };

function rank(type) {
  return TYPE_RANK[type] ?? 9;
}

// Neither server sends ETag/Last-Modified. ANM (Salesforce) honours Range, so the ZIP tail is enough to see
// whether its files changed; EAV (PHP) ignores Range and always sends the full zip.
const PROBE_BYTES = 65536;
// ponytail: skips the network on frequent cold starts; staleness ceiling is this plus the 6h refresh interval.
const MIN_CHECK_AGE = 3 * 60 * 60 * 1000;

function sha(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

/** Fingerprint of the wanted GTFS files (name, CRC32, size; not mtimes) from a ZIP or its tail at `base`. null if unreadable. */
export function zipFingerprint(buf, base = 0) {
  let entries;
  try {
    entries = centralDirectory(buf, base);
  } catch {
    return null;
  }
  const parts = (entries || [])
    .map((entry) => ({ ...entry, name: entry.name.split("/").pop() }))
    .filter((entry) => WANTED.has(entry.name))
    .map((entry) => `${entry.name}:${entry.crc}:${entry.size}`)
    .sort();
  return parts.length ? sha(parts.join("\n")) : null;
}

/**
 * GET a feed. With `probe` asks only the ZIP tail: a 206 yields { fingerprint } without the zip;
 * a server that ignores Range answers 200 and the full { buffer } comes back instead.
 */
async function fetchFeed(url, probe) {
  const headers = { "user-agent": UA, accept: "application/zip,*/*" };
  if (probe) headers.range = `bytes=-${PROBE_BYTES}`;
  const response = await fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${url} ha risposto ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (response.status !== 206) return { buffer, bytes: buffer.length };
  return { fingerprint: tailFingerprint(buffer, response.headers.get("content-range")), bytes: buffer.length };
}

/** Fingerprint of a 206 body, only if Content-Range says it is the true end of the file. */
export function tailFingerprint(buffer, contentRange) {
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || "");
  if (!range) return null;
  const [first, last, total] = range.slice(1).map(Number);
  if (last !== total - 1 || last - first + 1 !== buffer.length) return null;
  return zipFingerprint(buffer, first);
}

/**
 * offline: only open the DB already on disk (null if missing), no network.
 * Otherwise check upstream and rebuild in a worker if a feed changed. When nothing changed,
 * returns db: null if the caller already has the schedule loaded (`loaded`).
 */
export async function openSchedule(root, { offline = false, loaded = false } = {}) {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const manifestPath = path.join(dataDir, "manifest.json");
  const dbPath = path.join(dataDir, "schedule.sqlite");
  let previous = null;
  try {
    previous = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    previous = null;
  }
  const cached = previous?.schema === SCHEMA && existsSync(dbPath);
  // Offline boot serves any DB on disk, even an older schema (same tables); the online check rebuilds it.
  if (offline) return previous && existsSync(dbPath) ? { db: new DatabaseSync(dbPath), builtAt: previous.builtAt, rebuilt: false } : null;
  const unchanged = () => ({ db: loaded ? null : new DatabaseSync(dbPath), builtAt: previous.builtAt, rebuilt: false });
  const age = Date.now() - Date.parse(previous?.checkedAt);
  if (cached && age >= 0 && age < MIN_CHECK_AGE) {
    console.log(`orari controllati ${Math.round(age / 60000)} min fa, controllo rimandato`);
    return unchanged();
  }

  const zips = [];
  let changed = !cached;
  for (const feed of FEEDS) {
    const known = cached ? previous.fingerprints?.[feed.id] : undefined;
    const probe = await fetchFeed(feed.url, Boolean(known));
    if (probe.fingerprint && probe.fingerprint === known) {
      console.log(`${feed.id} invariato (sonda ${probe.bytes} byte)`);
      zips.push({ feed, buffer: null, hash: previous.hashes?.[feed.id], fingerprint: known });
      continue;
    }
    const got = probe.buffer ? probe : await fetchFeed(feed.url, false);
    const hash = sha(got.buffer);
    const fingerprint = zipFingerprint(got.buffer);
    // Same CRCs and sizes = same files even if the zip was re-packed; old manifests only have the sha1.
    const same = cached && (known && fingerprint ? fingerprint === known : previous.hashes?.[feed.id] === hash);
    if (!same) changed = true;
    console.log(`${feed.id} ${same ? "invariato" : "cambiato"} (scaricati ${probe === got ? got.bytes : probe.bytes + got.bytes} byte)`);
    zips.push({ feed, buffer: got.buffer, hash, fingerprint });
  }
  const manifest = (builtAt) => JSON.stringify(
    {
      builtAt,
      checkedAt: new Date().toISOString(),
      schema: SCHEMA,
      hashes: Object.fromEntries(zips.map((item) => [item.feed.id, item.hash])),
      fingerprints: Object.fromEntries(zips.map((item) => [item.feed.id, item.fingerprint || undefined])),
    },
    null,
    2,
  );
  if (!changed) {
    await writeFile(manifestPath, manifest(previous.builtAt));
    return unchanged();
  }
  // The DB is rebuilt from both feeds, so a feed the probe found unchanged is fetched in full.
  for (const item of zips) {
    if (item.buffer) continue;
    const got = await fetchFeed(item.feed.url, false);
    Object.assign(item, { buffer: got.buffer, hash: sha(got.buffer), fingerprint: zipFingerprint(got.buffer) });
  }
  const tmpPath = path.join(dataDir, "schedule.building.sqlite");
  await rm(tmpPath, { force: true });
  console.time("indicizzazione");
  await buildInWorker(tmpPath, zips);
  console.timeEnd("indicizzazione");
  await rm(dbPath, { force: true });
  await rename(tmpPath, dbPath);
  const builtAt = new Date().toISOString();
  await writeFile(manifestPath, manifest(builtAt));
  return { db: new DatabaseSync(dbPath), builtAt, rebuilt: true };
}

/** Runs build() in src/build-worker.js so parsing and inserts never block HTTP requests. */
function buildInWorker(dbPath, zips) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./build-worker.js", import.meta.url), {
      workerData: { dbPath, zips: zips.map(({ feed, buffer }) => ({ feed, buffer })) },
    });
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`indicizzazione interrotta (codice ${code})`))));
  });
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function utcDate(ymd) {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
}

/** Expand calendar.txt rows into dates, then apply calendar_dates.txt (1 adds, 2 removes). Map service_id -> Set of YYYYMMDD. */
export function serviceDates(calendar, exceptions) {
  const dates = new Map();
  const add = (serviceId, ymd) => {
    if (!dates.has(serviceId)) dates.set(serviceId, new Set());
    dates.get(serviceId).add(ymd);
  };
  for (const row of calendar) {
    if (!row.service_id || !/^\d{8}$/.test(row.start_date) || !/^\d{8}$/.test(row.end_date)) continue;
    const end = utcDate(row.end_date);
    for (const day = utcDate(row.start_date); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
      if (row[WEEKDAYS[day.getUTCDay()]] === "1") add(row.service_id, day.toISOString().slice(0, 10).replaceAll("-", ""));
    }
  }
  for (const row of exceptions) {
    if (!row.service_id || !row.date) continue;
    if (row.exception_type === "1") add(row.service_id, row.date);
    else if (row.exception_type === "2") dates.get(row.service_id)?.delete(row.date);
  }
  return dates;
}

export function build(dbPath, zips) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = OFF;
    CREATE TABLE routes (
      feed TEXT NOT NULL,
      route_id TEXT NOT NULL,
      agency_id TEXT,
      short_name TEXT,
      long_name TEXT,
      route_type INTEGER,
      color TEXT,
      operator TEXT,
      PRIMARY KEY (feed, route_id)
    );
    CREATE TABLE stops (
      feed TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      name TEXT,
      name_key TEXT,
      lat REAL,
      lon REAL,
      operator TEXT,
      kind INTEGER,
      PRIMARY KEY (feed, stop_id)
    );
    CREATE TABLE trips (
      feed TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      route_id TEXT,
      service_id TEXT,
      headsign TEXT,
      direction TEXT,
      PRIMARY KEY (feed, trip_id)
    );
    CREATE TABLE stop_times (
      feed TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      dep_sec INTEGER NOT NULL,
      seq INTEGER
    );
    CREATE TABLE service_dates (
      feed TEXT NOT NULL,
      service_id TEXT NOT NULL,
      ymd TEXT NOT NULL
    );
    CREATE TABLE patterns (
      feed TEXT NOT NULL,
      route_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      headsign TEXT,
      nstops INTEGER,
      shape_id TEXT
    );
    CREATE TABLE shapes (
      feed TEXT NOT NULL,
      shape_id TEXT NOT NULL,
      points TEXT NOT NULL,
      PRIMARY KEY (feed, shape_id)
    );
  `);

  const insertRoute = db.prepare(`INSERT INTO routes (feed, route_id, agency_id, short_name, long_name, route_type, color, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertStop = db.prepare(`INSERT OR REPLACE INTO stops (feed, stop_id, name, name_key, lat, lon, operator, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTrip = db.prepare(`INSERT INTO trips (feed, trip_id, route_id, service_id, headsign, direction)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insertTime = db.prepare(`INSERT INTO stop_times (feed, trip_id, stop_id, dep_sec, seq) VALUES (?, ?, ?, ?, ?)`);
  const insertService = db.prepare(`INSERT INTO service_dates (feed, service_id, ymd) VALUES (?, ?, ?)`);
  const insertPattern = db.prepare(`INSERT INTO patterns (feed, route_id, direction, trip_id, headsign, nstops, shape_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertShape = db.prepare(`INSERT OR REPLACE INTO shapes (feed, shape_id, points) VALUES (?, ?, ?)`);

  for (const { feed, buffer } of zips) {
    console.log(`indicizzo ${feed.id}`);
    const files = readZip(buffer, WANTED, OPTIONAL);
    if (!files.has("calendar.txt") && !files.has("calendar_dates.txt")) throw new Error("Mancano calendar.txt e calendar_dates.txt nel GTFS");
    const routes = parseCsv(files.get("routes.txt"));
    const routeById = new Map();
    db.exec("BEGIN");
    for (const route of routes) {
      const operator = feed.operators[route.agency_id];
      if (!operator) continue;
      const type = Number(route.route_type);
      const record = {
        id: route.route_id,
        short: route.route_short_name || "",
        long: route.route_long_name || "",
        type: Number.isFinite(type) ? type : 3,
        color: (route.route_color || "").replace("#", ""),
        operator,
      };
      routeById.set(route.route_id, record);
      insertRoute.run(feed.id, record.id, route.agency_id, record.short, record.long, record.type, record.color, record.operator);
    }
    db.exec("COMMIT");

    const trips = parseCsv(files.get("trips.txt"));
    const tripById = new Map();
    db.exec("BEGIN");
    for (const trip of trips) {
      const route = routeById.get(trip.route_id);
      if (!route) continue;
      const published = (trip.trip_headsign || "").trim();
      tripById.set(trip.trip_id, {
        routeId: trip.route_id,
        serviceId: trip.service_id,
        headsign: published,
        direction: trip.direction_id || "0",
        hasDirection: trip.direction_id === "0" || trip.direction_id === "1",
        shapeId: trip.shape_id || "",
        operator: route.operator,
        type: route.type,
        firstSeq: Infinity,
        firstStop: "",
        lastSeq: -1,
        lastStop: "",
        count: 0,
      });
      insertTrip.run(feed.id, trip.trip_id, trip.route_id, trip.service_id, published, trip.direction_id || "0");
    }
    db.exec("COMMIT");

    const bestKind = new Map();
    const bestOp = new Map();
    db.exec("BEGIN");
    let pending = 0;
    for (const row of iterateCsv(files.get("stop_times.txt"))) {
      const trip = tripById.get(row.trip_id);
      if (!trip) continue;
      const dep = seconds(row.departure_time) ?? seconds(row.arrival_time);
      if (dep == null) continue;
      const seq = Number(row.stop_sequence || 0);
      insertTime.run(feed.id, row.trip_id, row.stop_id, dep, seq);
      pending += 1;
      if (pending >= 20000) {
        db.exec("COMMIT");
        db.exec("BEGIN");
        pending = 0;
      }
      trip.count += 1;
      if (seq <= trip.firstSeq) {
        trip.firstSeq = seq;
        trip.firstStop = row.stop_id;
      }
      if (seq >= trip.lastSeq) {
        trip.lastSeq = seq;
        trip.lastStop = row.stop_id;
      }
      const prev = bestKind.get(row.stop_id);
      if (prev == null || rank(trip.type) < rank(prev)) {
        bestKind.set(row.stop_id, trip.type);
        bestOp.set(row.stop_id, trip.operator);
      }
    }
    db.exec("COMMIT");

    const stopNames = new Map();
    db.exec("BEGIN");
    for (const stop of parseCsv(files.get("stops.txt"))) {
      const lat = Number(stop.stop_lat);
      const lon = Number(stop.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!bestOp.has(stop.stop_id)) continue;
      const stopName = (stop.stop_name || "").trim();
      stopNames.set(stop.stop_id, stopName);
      insertStop.run(
        feed.id,
        stop.stop_id,
        stopName,
        nameKey(stopName),
        Math.round(lat * 1e5) / 1e5,
        Math.round(lon * 1e5) / 1e5,
        bestOp.get(stop.stop_id),
        bestKind.get(stop.stop_id) ?? 3,
      );
    }
    db.exec("COMMIT");

    const updateHead = db.prepare(`UPDATE trips SET headsign = ? WHERE feed = ? AND trip_id = ? AND headsign = ''`);
    db.exec("BEGIN");
    const candidates = new Map();
    for (const [tripId, trip] of tripById) {
      if (!trip.count) continue;
      if (!trip.headsign && trip.lastStop) {
        const place = stopNames.get(trip.lastStop);
        if (place) updateHead.run(place, feed.id, tripId);
        trip.headsign = place || "";
      }
      const direction = trip.hasDirection ? trip.direction : `t:${trip.lastStop}`;
      const key = `${trip.routeId}|${direction}`;
      const current = candidates.get(key);
      if (!current || trip.count > current.count) {
        candidates.set(key, { tripId, direction, headsign: trip.headsign, count: trip.count, routeId: trip.routeId, shapeId: trip.shapeId, firstStop: trip.firstStop, lastStop: trip.lastStop, synthetic: !trip.hasDirection });
      }
    }
    const byRoute = new Map();
    for (const pattern of candidates.values()) {
      if (!byRoute.has(pattern.routeId)) byRoute.set(pattern.routeId, []);
      byRoute.get(pattern.routeId).push(pattern);
    }
    const chosen = [];
    for (const list of byRoute.values()) {
      const real = list.filter((pattern) => !pattern.synthetic);
      chosen.push(...real);
      const synthetic = list.filter((pattern) => pattern.synthetic).sort((a, b) => b.count - a.count);
      if (!synthetic.length) continue;
      const first = synthetic[0];
      const back = synthetic.find((pattern, index) => index > 0 && pattern.lastStop === first.firstStop)
        || synthetic.find((pattern, index) => index > 0 && pattern.lastStop !== first.lastStop);
      chosen.push(first);
      if (back) chosen.push(back);
    }
    const neededShapes = new Set(chosen.map((pattern) => pattern.shapeId).filter(Boolean));
    for (const pattern of chosen) {
      insertPattern.run(feed.id, pattern.routeId, pattern.direction, pattern.tripId, pattern.headsign, pattern.count, pattern.shapeId || null);
    }
    if (files.get("shapes.txt") && neededShapes.size) {
      const points = new Map();
      for (const row of iterateCsv(files.get("shapes.txt"))) {
        if (!neededShapes.has(row.shape_id)) continue;
        const lat = Number(row.shape_pt_lat);
        const lon = Number(row.shape_pt_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (!points.has(row.shape_id)) points.set(row.shape_id, []);
        points.get(row.shape_id).push([Number(row.shape_pt_sequence || 0), Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
      }
      for (const [shapeId, list] of points) {
        list.sort((a, b) => a[0] - b[0]);
        insertShape.run(feed.id, shapeId, JSON.stringify(list.map((point) => [point[1], point[2]])));
      }
    }
    db.exec("COMMIT");

    db.exec("BEGIN");
    const csv = (name) => (files.has(name) ? parseCsv(files.get(name)) : []);
    for (const [serviceId, days] of serviceDates(csv("calendar.txt"), csv("calendar_dates.txt"))) {
      for (const ymd of days) insertService.run(feed.id, serviceId, ymd);
    }
    db.exec("COMMIT");
    console.log(`indicizzato ${feed.id}: ${routeById.size} linee`);
  }

  db.exec(`
    CREATE INDEX ix_times ON stop_times (feed, stop_id, dep_sec);
    CREATE INDEX ix_trip_times ON stop_times (feed, trip_id, seq);
    CREATE INDEX ix_service ON service_dates (feed, ymd, service_id);
    CREATE INDEX ix_stop_key ON stops (name_key);
  `);
  return db;
}

function seconds(value) {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
