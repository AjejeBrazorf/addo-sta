import { bearingBetween, metres } from "./geo.js";
import { clockFromSeconds, fsCodeForGtfsStop, nameKey, previousYmd, romeNow, TYPE_LABEL } from "./places.js";

let database = null;
let railCache = null;
let railLines = null;
let routeIndex = null;
let fsLinks = null;

const GTFS_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function setDatabase(db) {
  const previous = database;
  database = db;
  railCache = null;
  railLines = null;
  routeIndex = null;
  fsLinks = null;
  tripPathCache.clear();
  headsignCache.clear();
  directionCache.clear();
  if (previous && previous !== db) {
    try {
      previous.close();
    } catch {
      /* the new file is already open */
    }
  }
}

export function ready() {
  return Boolean(database);
}

function db() {
  if (!database) {
    const error = new Error("Orari ancora in caricamento");
    error.status = 503;
    throw error;
  }
  return database;
}

export function suggest(query, operator) {
  const q = nameKey(query).slice(0, 40);
  if (q.length < 2) return { stops: [], routes: [] };
  const like = `%${q}%`;
  const opClause = operator ? "AND operator = ?" : "";
  const opArgs = operator ? [operator] : [];
  const stops = db()
    .prepare(
      `SELECT feed, stop_id, name, lat, lon, operator, kind FROM stops
       WHERE name_key LIKE ? ${opClause}
       ORDER BY CASE operator WHEN 'fs' THEN 0 WHEN 'eav-rail' THEN 1 WHEN 'anm' THEN 2 ELSE 3 END,
                CASE WHEN name_key LIKE ? THEN 0 ELSE 1 END, length(name_key)
       LIMIT 40`,
    )
    .all(like, ...opArgs, `${q}%`);
  const routes = [];
  for (const entry of routeList()) {
    if (routes.length === 12) break;
    if (operator && entry.route.operator !== operator) continue;
    // match on the same nameKey as the query, so "pompei scavi" finds "Napoli - Pompei Scavi - Sorrento"
    if (entry.shortKey.includes(q) || entry.longKey.includes(q)) routes.push(entry.route);
  }
  const groups = groupStops(stops).slice(0, 12);
  const lines = linesFor(groups);
  return {
    stops: groups.map((stop, i) => ({ ...stop, lines: lines[i] })),
    routes: routes.map(routeDto),
  };
}

/** All routes with their search keys, ordered like the old SQL (length(short_name), short_name). */
function routeList() {
  if (!routeIndex) {
    routeIndex = db()
      .prepare(`SELECT feed, route_id, short_name, long_name, route_type, color, operator FROM routes`)
      .all()
      .map((route) => ({ route, shortKey: nameKey(route.short_name), longKey: nameKey(route.long_name) }))
      .sort((a, b) => {
        const x = a.route.short_name;
        const y = b.route.short_name;
        return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
      });
  }
  return routeIndex;
}

/** Line numbers calling at each stop group (max 8 ids, 12 lines per group), in one query per feed. */
function linesFor(groups) {
  const cleanIds = groups.map((group) => [...new Set(group.ids)].filter((id) => GTFS_ID.test(id)).slice(0, 8));
  const byStop = new Map();
  for (const feed of new Set(groups.map((group) => group.feed))) {
    const ids = [...new Set(cleanIds.filter((_, i) => groups[i].feed === feed).flat())];
    if (!ids.length) continue;
    const rows = db()
      .prepare(
        `SELECT DISTINCT st.stop_id AS stop_id, r.short_name AS short FROM stop_times st
         JOIN trips t ON t.feed = st.feed AND t.trip_id = st.trip_id
         JOIN routes r ON r.feed = t.feed AND r.route_id = t.route_id
         WHERE st.feed = ? AND st.stop_id IN (${ids.map(() => "?").join(",")}) AND r.short_name <> ''`,
      )
      .all(feed, ...ids);
    for (const row of rows) {
      const key = `${feed}|${row.stop_id}`;
      if (!byStop.has(key)) byStop.set(key, []);
      byStop.get(key).push(row.short);
    }
  }
  return groups.map((group, i) => {
    const shorts = new Set(cleanIds[i].flatMap((id) => byStop.get(`${group.feed}|${id}`) || []));
    return [...shorts].sort((a, b) => a.localeCompare(b, "it", { numeric: true })).slice(0, 12);
  });
}

function groupStops(rows) {
  const groups = [];
  for (const row of rows) {
    const found = groups.find((group) => group.operator === row.operator && nameKey(group.name) === nameKey(row.name) && metres(group.lat, group.lon, row.lat, row.lon) < 180);
    if (found) {
      found.ids.push(row.stop_id);
      continue;
    }
    groups.push({
      feed: row.feed,
      ids: [row.stop_id],
      name: row.name.trim(),
      lat: row.lat,
      lon: row.lon,
      operator: row.operator,
      kind: row.kind,
      fsCode: row.operator === "fs" ? fsCodeForGtfsStop(row.name) : null,
    });
  }
  return groups;
}

function routeDto(route) {
  return {
    feed: route.feed,
    id: route.route_id,
    short: route.short_name,
    long: route.long_name,
    type: route.route_type,
    typeLabel: TYPE_LABEL[route.route_type] || "Corsa",
    color: route.color || "",
    operator: route.operator,
  };
}

export function departures(feed, ids) {
  if (feed !== "eav" && feed !== "anm") throw new Error("Rete non valida");
  const clean = [...new Set(ids)].slice(0, 8);
  if (!clean.length || clean.some((id) => !GTFS_ID.test(id))) throw new Error("Fermata non valida");
  const now = romeNow();
  const windows = [
    { ymd: now.ymd, from: Math.max(0, now.seconds - 60), to: now.seconds + 3 * 3600, shift: 0 },
  ];
  if (now.seconds < 5 * 3600) {
    windows.push({
      ymd: previousYmd(now.ymd),
      from: now.seconds + 86400 - 60,
      to: now.seconds + 86400 + 3 * 3600,
      shift: 86400,
    });
  }
  const marks = clean.map(() => "?").join(",");
  const statement = db().prepare(
    `SELECT st.dep_sec AS dep, st.trip_id AS trip_id, st.stop_id AS stop_id, t.headsign AS headsign,
            r.route_id AS route_id, r.short_name AS short_name,
            r.long_name AS long_name, r.route_type AS route_type, r.color AS color, r.operator AS operator
     FROM stop_times st
     JOIN trips t ON t.feed = st.feed AND t.trip_id = st.trip_id
     JOIN service_dates sd ON sd.feed = t.feed AND sd.service_id = t.service_id AND sd.ymd = ?
     JOIN routes r ON r.feed = t.feed AND r.route_id = t.route_id
     WHERE st.feed = ? AND st.stop_id IN (${marks}) AND st.dep_sec >= ? AND st.dep_sec <= ?
     ORDER BY st.dep_sec
     LIMIT 40`,
  );
  const rows = [];
  for (const window of windows) {
    for (const row of statement.all(window.ymd, feed, ...clean, window.from, window.to)) {
      const dep = row.dep - window.shift;
      rows.push({
        time: clockFromSeconds(row.dep),
        tripId: row.trip_id,
        stopId: row.stop_id,
        inMinutes: Math.round((dep - now.seconds) / 60),
        headsign: String(row.headsign || "").trim(),
        routeId: row.route_id,
        short: row.short_name,
        long: row.long_name,
        type: row.route_type,
        typeLabel: TYPE_LABEL[row.route_type] || "Corsa",
        color: row.color || "",
        operator: row.operator,
        feed,
      });
    }
  }
  rows.sort((a, b) => a.inMinutes - b.inMinutes);
  const stop = db()
    .prepare(`SELECT name, lat, lon, operator, kind FROM stops WHERE feed = ? AND stop_id = ?`)
    .get(feed, clean[0]);
  return {
    name: (stop?.name || "").trim(),
    lat: stop?.lat ?? null,
    lon: stop?.lon ?? null,
    operator: stop?.operator || null,
    kind: stop?.kind ?? null,
    fsCode: stop?.operator === "fs" ? fsCodeForGtfsStop(stop.name) : null,
    updatedAt: new Date().toISOString(),
    rows: rows.slice(0, 18),
  };
}

export function routeLabels(feed, routeIds) {
  const labels = new Map();
  if (!database || !routeIds.length) return labels;
  const unique = [...new Set(routeIds)].filter((id) => GTFS_ID.test(id));
  const marks = unique.map(() => "?").join(",");
  if (!marks) return labels;
  const rows = database
    .prepare(`SELECT route_id, short_name, long_name, route_type FROM routes WHERE feed = ? AND route_id IN (${marks})`)
    .all(feed, ...unique);
  for (const row of rows) {
    labels.set(row.route_id, {
      short: row.short_name || "",
      long: String(row.long_name || "").trim(),
      typeLabel: TYPE_LABEL[row.route_type] || "Corsa",
    });
  }
  return labels;
}

export function routeDetail(feed, routeId, tripId = "") {
  if (feed !== "eav" && feed !== "anm") throw new Error("Rete non valida");
  if (!GTFS_ID.test(routeId)) throw new Error("Linea non valida");
  const route = db()
    .prepare(`SELECT feed, route_id, short_name, long_name, route_type, color, operator FROM routes WHERE feed = ? AND route_id = ?`)
    .get(feed, routeId);
  if (!route) {
    const error = new Error("Linea non trovata");
    error.status = 404;
    throw error;
  }
  const patterns = db()
    .prepare(`SELECT direction, trip_id, headsign, shape_id FROM patterns WHERE feed = ? AND route_id = ? ORDER BY direction`)
    .all(feed, routeId);
  const stops = db().prepare(
    `SELECT st.seq AS seq, s.stop_id AS stop_id, s.name AS name, s.lat AS lat, s.lon AS lon
     FROM stop_times st JOIN stops s ON s.feed = st.feed AND s.stop_id = st.stop_id
     WHERE st.feed = ? AND st.trip_id = ?
     ORDER BY st.seq`,
  );
  const shape = db().prepare(`SELECT points FROM shapes WHERE feed = ? AND shape_id = ?`);
  const directions = patterns.map((pattern) => {
    const row = pattern.shape_id ? shape.get(feed, pattern.shape_id) : null;
    return {
      direction: pattern.direction,
      headsign: pattern.headsign,
      stops: stops.all(feed, pattern.trip_id).map((stop) => ({ ...stop, name: String(stop.name || "").trim() })),
      shape: row ? JSON.parse(row.points) : null,
    };
  });
  return { ...routeDto(route), directions, activeDirection: activeDirection(feed, routeId, tripId, patterns, directions) };
}

function activeDirection(feed, routeId, tripId, patterns, directions) {
  if (!tripId || !TRIP_ID.test(tripId)) return 0;
  const trip = db().prepare(`SELECT direction FROM trips WHERE feed = ? AND trip_id = ? AND route_id = ?`).get(feed, tripId, routeId);
  if (!trip) return 0;
  const byDirection = patterns.findIndex((pattern) => pattern.direction === trip.direction);
  if (byDirection >= 0) return byDirection;
  const last = db().prepare(`SELECT stop_id FROM stop_times WHERE feed = ? AND trip_id = ? ORDER BY seq DESC LIMIT 1`).get(feed, tripId);
  if (!last) return 0;
  const byTerminus = directions.findIndex((direction) => direction.stops.length && direction.stops[direction.stops.length - 1].stop_id === last.stop_id);
  return byTerminus >= 0 ? byTerminus : 0;
}

export function linesAt(feed, ids) {
  if (feed !== "eav" && feed !== "anm") throw new Error("Rete non valida");
  const clean = [...new Set(ids)].filter((id) => GTFS_ID.test(id)).slice(0, 8);
  if (!clean.length) return [];
  const marks = clean.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT DISTINCT r.route_id AS route_id, r.short_name AS short_name, r.long_name AS long_name, r.route_type AS route_type, r.color AS color, r.operator AS operator
       FROM stop_times st
       JOIN trips t ON t.feed = st.feed AND t.trip_id = st.trip_id
       JOIN routes r ON r.feed = t.feed AND r.route_id = t.route_id
       WHERE st.feed = ? AND st.stop_id IN (${marks})
       LIMIT 40`,
    )
    .all(feed, ...clean);
  return rows
    .map((row) => routeDto({ ...row, feed }))
    .sort((a, b) => (a.short || a.long).localeCompare(b.short || b.long, "it", { numeric: true }));
}

/* Line numbers per stop for the map badges: "L1" / "F1" -> "1", "9." (short-run variant) -> "9".
   Rail stops list only their own mode; street stops (bus, filobus, tram) list every street line calling there. */
function lineBadges() {
  if (!railLines) {
    railLines = new Map();
    const rows = db().prepare(
      `SELECT DISTINCT s.feed, s.stop_id, s.kind, r.short_name AS short FROM stops s
       JOIN stop_times st ON st.feed = s.feed AND st.stop_id = s.stop_id
       JOIN trips t ON t.feed = st.feed AND t.trip_id = st.trip_id
       JOIN routes r ON r.feed = t.feed AND r.route_id = t.route_id
       WHERE (r.route_type = s.kind OR (s.kind IN (0, 3, 11) AND r.route_type IN (0, 3, 11)))
         AND s.kind IN (0, 1, 2, 3, 7, 11) AND r.short_name <> ''`,
    ).all();
    for (const row of rows) {
      const key = `${row.feed}|${row.stop_id}`;
      // metro "L1" and funicolare "F1" keep only the number; the badge colour already says which
      const label = row.short.trim().replace(row.kind === 1 || row.kind === 7 ? /^[LF]/i : /^$/, "").replace(/\.+$/, "");
      if (!label) continue;
      const set = railLines.get(key) || new Set();
      set.add(label);
      railLines.set(key, set);
    }
  }
  return railLines;
}

export function mapStops(layer) {
  const where = layer === "bus"
    ? "kind IN (3, 11)"
    : "kind IN (0, 1, 2, 7)";
  const rows = db()
    .prepare(`SELECT feed, stop_id, name, lat, lon, operator, kind FROM stops WHERE ${where}`)
    .all();
  const lines = lineBadges();
  return rows.map((row) => ({
    l: lines?.has(`${row.feed}|${row.stop_id}`)
      ? [...lines.get(`${row.feed}|${row.stop_id}`)].sort((a, b) => a.localeCompare(b, "it", { numeric: true }))
      : undefined,
    f: row.feed,
    i: row.stop_id,
    n: row.name.trim(),
    y: row.lat,
    x: row.lon,
    o: row.operator,
    k: row.kind,
  }));
}

function looseKey(name) {
  return nameKey(name).replaceAll("PIAZZA", "P");
}

export function eavStopsFor(name) {
  if (!database) return null;
  if (!railCache) {
    railCache = database.prepare(`SELECT feed, stop_id, name FROM stops WHERE operator = 'eav-rail'`).all();
  }
  const key = looseKey(name);
  const rows = railCache.filter((row) => looseKey(row.name) === key).slice(0, 8);
  if (!rows.length) return null;
  return { feed: rows[0].feed, ids: rows.map((row) => row.stop_id) };
}

/** FS Linea 2 stops in the ANM feed, grouped per station. Cached until the next setDatabase; callers must not mutate. */
export function linkFsStops() {
  if (!fsLinks) {
    const rows = db()
      .prepare(`SELECT stop_id, name, lat, lon FROM stops WHERE feed = 'anm' AND operator = 'fs'`)
      .all();
    fsLinks = groupStops(rows.map((row) => ({ ...row, feed: "anm", operator: "fs", kind: 1 })));
  }
  return fsLinks;
}

const TRIP_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const tripPathCache = new Map();
const headsignCache = new Map();
const CACHE_MAX = 4000;

function remember(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/** Ordered [lat, lon] path of a trip: its route shape when the pattern has one, else its stops. */
function tripPath(feed, tripId) {
  const key = `${feed}|${tripId}`;
  if (tripPathCache.has(key)) return tripPathCache.get(key);
  const trip = db().prepare(`SELECT route_id, direction FROM trips WHERE feed = ? AND trip_id = ?`).get(feed, tripId);
  let path = null;
  if (trip) {
    const pattern = db()
      .prepare(`SELECT shape_id FROM patterns WHERE feed = ? AND route_id = ? AND direction = ? AND shape_id IS NOT NULL LIMIT 1`)
      .get(feed, trip.route_id, trip.direction);
    const shape = pattern ? db().prepare(`SELECT points FROM shapes WHERE feed = ? AND shape_id = ?`).get(feed, pattern.shape_id) : null;
    if (shape) {
      try {
        path = JSON.parse(shape.points);
      } catch {
        path = null;
      }
    }
  }
  if (!path || path.length < 2) {
    const stops = db()
      .prepare(
        `SELECT s.lat AS lat, s.lon AS lon FROM stop_times st
         JOIN stops s ON s.feed = st.feed AND s.stop_id = st.stop_id
         WHERE st.feed = ? AND st.trip_id = ? ORDER BY st.seq`,
      )
      .all(feed, tripId);
    path = stops.map((stop) => [stop.lat, stop.lon]);
  }
  return remember(tripPathCache, key, path.length >= 2 ? path : null);
}

/** Bearing of the segment of the trip's path nearest to the point, or null. */
export function tripBearing(feed, tripId, lat, lon) {
  if (!database || (feed !== "eav" && feed !== "anm")) return null;
  if (typeof tripId !== "string" || !TRIP_ID.test(tripId) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const path = tripPath(feed, tripId);
  if (!path) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < path.length - 1; i += 1) {
    const [aLat, aLon] = path[i];
    const [bLat, bLon] = path[i + 1];
    const ax = (aLon - lon) * kx;
    const ay = aLat - lat;
    const dx = (bLon - aLon) * kx;
    const dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best < 0 || bestDist * 111000 > 400) return null;
  return bearingBetween(path[best][0], path[best][1], path[best + 1][0], path[best + 1][1]);
}

/** Map of tripId to headsign for the given trips (batched, cached). */
export function tripHeadsigns(feed, tripIds) {
  const result = new Map();
  if (!database || (feed !== "eav" && feed !== "anm")) return result;
  const missing = [];
  for (const id of new Set(tripIds)) {
    if (typeof id !== "string" || !TRIP_ID.test(id)) continue;
    const key = `${feed}|${id}`;
    if (headsignCache.has(key)) result.set(id, headsignCache.get(key));
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 300) {
    const chunk = missing.slice(i, i + 300);
    const marks = chunk.map(() => "?").join(",");
    const found = new Set();
    for (const row of database.prepare(`SELECT trip_id, headsign FROM trips WHERE feed = ? AND trip_id IN (${marks})`).all(feed, ...chunk)) {
      const headsign = String(row.headsign || "").trim();
      found.add(row.trip_id);
      result.set(row.trip_id, headsign);
      remember(headsignCache, `${feed}|${row.trip_id}`, headsign);
    }
    for (const id of chunk) if (!found.has(id)) remember(headsignCache, `${feed}|${id}`, "");
  }
  return result;
}

const directionCache = new Map();

/** Map of tripId to GTFS direction_id (0/1) for the given trips (batched, cached). */
export function tripDirections(feed, tripIds) {
  const result = new Map();
  if (!database || (feed !== "eav" && feed !== "anm")) return result;
  const missing = [];
  for (const id of new Set(tripIds)) {
    if (typeof id !== "string" || !TRIP_ID.test(id)) continue;
    const key = `${feed}|${id}`;
    if (directionCache.has(key)) result.set(id, directionCache.get(key));
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 300) {
    const chunk = missing.slice(i, i + 300);
    const marks = chunk.map(() => "?").join(",");
    const found = new Set();
    for (const row of database.prepare(`SELECT trip_id, direction FROM trips WHERE feed = ? AND trip_id IN (${marks})`).all(feed, ...chunk)) {
      const direction = row.direction == null ? null : Number(row.direction);
      found.add(row.trip_id);
      result.set(row.trip_id, direction);
      remember(directionCache, `${feed}|${row.trip_id}`, direction);
    }
    for (const id of chunk) if (!found.has(id)) remember(directionCache, `${feed}|${id}`, null);
  }
  return result;
}
