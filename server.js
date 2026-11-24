import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGzip, gzipSync } from "node:zlib";
import { cookieValid, failureLimiter, missingSecrets, sameText, sessionToken as makeSessionToken } from "./src/auth.js";
import { openSchedule } from "./src/ingest.js";
import { eavBoard, eavStations, fsBoard, fsStations } from "./src/live.js";
import { cleanQuery, nameKey, OP_LABEL, romeNow } from "./src/places.js";
import { withHeadings } from "./src/heading.js";
import { predictions, vehicles } from "./src/realtime.js";
import { departures, eavStopsFor, linesAt, linkFsStops, mapStops, ready, routeDetail, routeLabels, setDatabase, suggest, tripDirections, tripHeadsigns } from "./src/schedule.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

const state = {
  schedule: false,
  rebuilding: false,
  builtAt: null,
  error: null,
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// Private access: set ACCESS_PASSWORD to require a shared password. One cookie per device, valid one year.
// ponytail: single shared password, change it (or SESSION_SECRET) to log everyone out; per-user accounts if the group grows.
const missing = missingSecrets(process.env);
if (missing.length) {
  console.error(`accesso non configurato: manca ${missing.join(", ")} (fly secrets set ...). Avvio annullato.`);
  process.exit(1);
}
const password = process.env.ACCESS_PASSWORD || "";
// Dev fallback: a random secret per process, so cookies die on restart.
const sessionToken = password && makeSessionToken(process.env.SESSION_SECRET || randomBytes(32).toString("hex"), password);
const PUBLIC_PATHS = new Set(["/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/favicon.svg"]);
const loginFailures = failureLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

// Fly's proxy sets fly-client-ip; anywhere else the header is client-controlled, so use the socket.
function clientIp(req) {
  return (process.env.FLY_APP_NAME && req.headers["fly-client-ip"]) || req.socket.remoteAddress || "?";
}

function authorized(req) {
  return cookieValid(req.headers.cookie, sessionToken);
}

function loginPage(res, code = 200, alert = "") {
  const body = `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Banchina · Accesso</title><link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png"><meta name="theme-color" content="#1d4e89">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d4e89;color:#f4efe4;font:16px system-ui,sans-serif}
form{display:grid;gap:12px;width:min(320px,100% - 32px)}input,button{font:inherit;padding:12px;border-radius:10px;border:0}button{background:#f4efe4;color:#1d4e89;font-weight:600}</style></head>
<body><form method="post" action="/login"><h1 style="margin:0">Banchina</h1>${alert ? `<p role="alert">${alert}</p>` : ""}
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus><button>Entra</button></form></body></html>`;
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function login(req, res) {
  const ip = clientIp(req);
  if (loginFailures.blocked(ip)) {
    loginPage(res, 429, "Troppi tentativi. Riprova tra 15 minuti.");
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2048) break;
  }
  const given = new URLSearchParams(raw).get("password") || "";
  if (!sameText(given, password)) {
    loginFailures.fail(ip);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // slow down guessing
    loginPage(res, 401, "Password errata.");
    return;
  }
  loginFailures.reset(ip);
  res.writeHead(303, {
    location: "/",
    "set-cookie": `banchina=${sessionToken}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
  });
  res.end();
}

function wantsGzip(res) {
  return /\bgzip\b/.test(res.req?.headers["accept-encoding"] || "");
}

function send(res, code, body) {
  let payload = Buffer.from(JSON.stringify(body));
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "accept-encoding" };
  // ponytail: sync gzip blocks a few ms on the biggest payload (/api/places?layer=bus); async zlib if that ever shows up
  if (payload.length > 1024 && wantsGzip(res)) {
    payload = gzipSync(payload);
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = payload.length;
  res.writeHead(code, headers);
  res.end(payload);
}

// 5xx messages reach the client only when marked safe (expose) or listed here; the rest is logged.
const SAFE_5XX = new Set(["Orari ancora in caricamento"]);

function fail(res, error) {
  // Plain `new Error` = input validation (400); TypeError, sqlite and other internals = 500.
  const status = error.status || (error.code || error.constructor !== Error ? 500 : 400);
  if (status < 500 || error.expose || SAFE_5XX.has(error.message)) {
    send(res, status, { error: error.message || "Richiesta non riuscita" });
    return;
  }
  console.error("errore", status, error);
  send(res, status, { error: status === 502 ? "Sorgente esterna non disponibile, riprova tra poco" : "Errore interno, riprova tra poco" });
}

let refreshing = false;
// offline: open the DB already on disk without touching the network (boot).
async function refresh({ offline = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  state.rebuilding = !offline;
  try {
    const result = await openSchedule(root, { offline, loaded: state.schedule });
    if (!result) {
      console.log("nessun orario in archivio");
      return;
    }
    if (result.db) setDatabase(result.db);
    state.schedule = true;
    state.builtAt = result.builtAt;
    state.error = null;
    console.log(result.rebuilt ? `orari aggiornati ${result.builtAt}` : "orari già in archivio");
  } catch (error) {
    state.error = error.message;
    console.error("orari non aggiornati:", error.message);
  } finally {
    state.rebuilding = false;
    refreshing = false;
  }
}

function fsMatches(query) {
  const key = nameKey(query);
  if (key.length < 2) return [];
  return fsStations().filter((station) => nameKey(station.name).includes(key) || nameKey(station.short).includes(key));
}

function eavMatches(stations, query) {
  const key = nameKey(query);
  if (key.length < 2) return []; // "linea 6" -> "6": leave it to the exact line match
  return stations.filter((station) => nameKey(station.name).includes(key) || station.lines.some((line) => nameKey(line).includes(key)));
}

async function search(rawQuery, operator) {
  const query = cleanQuery(rawQuery) || rawQuery;
  const gtfs = ready() ? suggest(query, operator) : { stops: [], routes: [] };
  let stations = [];
  try {
    stations = await eavStations();
  } catch {
    stations = [];
  }
  const linked = ready() ? linkFsStops() : [];
  const takenFs = new Set(gtfs.stops.map((stop) => stop.fsCode).filter(Boolean));
  const fs = operator && operator !== "fs" ? [] : fsMatches(query).filter((station) => !takenFs.has(station.code));
  const eav = !operator || operator === "eav-rail"
    ? eavMatches(stations, query).slice(0, 8).filter((station) => !gtfs.stops.some((stop) => stop.operator === "eav-rail" && nameKey(stop.name) === nameKey(station.name)))
    : [];
  return {
    fs: fs.map((station) => ({
      code: station.code,
      name: station.name,
      short: station.short,
      lat: station.lat,
      lon: station.lon,
      schedule: linked.filter((stop) => stop.fsCode === station.code).map((stop) => ({ feed: stop.feed, ids: stop.ids })),
    })),
    eav: eav.map((station) => ({ ...station, schedule: eavStopsFor(station.name) })),
    stops: gtfs.stops,
    routes: gtfs.routes,
  };
}

async function liveDepartures(feed, ids) {
  const board = departures(feed, ids);
  if (feed !== "anm") return board;
  let predicted;
  try {
    predicted = await predictions();
  } catch (error) {
    return { ...board, realtime: { ok: false, error: error.message } };
  }
  const nowSec = Date.now() / 1000;
  const rows = board.rows
    .map((row) => {
      const hit = predicted.get(`${row.tripId}|${row.stopId}`);
      if (!hit) return { ...row, scheduled: row.time, live: false, delayMin: null };
      return {
        ...row,
        scheduled: row.time,
        time: romeNow(new Date(hit.time * 1000)).label,
        live: true,
        delayMin: hit.delaySec == null ? null : Math.round(hit.delaySec / 60),
        inMinutes: Math.round((hit.time - nowSec) / 60),
      };
    })
    .filter((row) => row.inMinutes == null || row.inMinutes >= -1)
    .sort((a, b) => a.inMinutes - b.inMinutes);
  return { ...board, rows, realtime: { ok: true, source: "BusOne", kind: "previsioni" } };
}

async function liveVehicles() {
  let data;
  try {
    data = await vehicles();
  } catch (error) {
    const failure = new Error(`Posizioni ANM non disponibili: ${error.message}`);
    failure.status = 502;
    failure.expose = Boolean(error.expose);
    throw failure;
  }
  const labels = routeLabels("anm", data.vehicles.map((vehicle) => vehicle.routeId));
  const headsigns = ready() ? tripHeadsigns("anm", data.vehicles.map((vehicle) => vehicle.tripId)) : new Map();
  const directions = ready() ? tripDirections("anm", data.vehicles.map((vehicle) => vehicle.tripId)) : new Map();
  const list = ready() ? withHeadings(data.vehicles) : data.vehicles.map((vehicle) => ({ ...vehicle, bearingSource: vehicle.bearing == null ? null : "feed" }));
  return {
    feedTimestamp: data.feedTimestamp,
    updatedAt: new Date().toISOString(),
    source: "BusOne · GPS misurato",
    vehicles: list.map((vehicle) => ({ ...vehicle, headsign: headsigns.get(vehicle.tripId) || "", direction: directions.has(vehicle.tripId) ? directions.get(vehicle.tripId) : null, route: labels.get(vehicle.routeId) || null })),
  };
}

// Hosts the frontend loads from: jsDelivr (Leaflet, MapLibre), Google Fonts, OpenFreeMap (vector tiles + glyphs via fetch),
// OSM raster tiles (fallback basemap). The sha256 is the inline theme <script> in public/index.html: update it if that script changes.
// style-src needs 'unsafe-inline': lanes.js renders SVG with style="" attributes, and the login page has an inline <style>.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'sha256-zlH4LTAorHV+PE0fFrSzBauiHNHByvxI87Y7bgfRRfM='",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://cdn.jsdelivr.net https://tile.openstreetmap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "child-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function handle(req, res) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "DENY");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    // Liveness for Fly checks: public, always 200 while the process serves. Not 503 without a schedule:
    // with one machine Fly would route away and the live boards (which need no schedule) would go down too.
    if (url.pathname === "/healthz") {
      send(res, 200, { ok: true, schedule: state.schedule });
      return;
    }
    if (password && !PUBLIC_PATHS.has(url.pathname) && !authorized(req)) {
      if (url.pathname === "/login" && req.method === "POST") await login(req, res);
      else if (url.pathname.startsWith("/api/")) send(res, 401, { error: "Accesso richiesto" });
      else loginPage(res);
      return;
    }
    if (url.pathname === "/api/status") {
      send(res, 200, {
        schedule: state.schedule,
        rebuilding: state.rebuilding,
        builtAt: state.builtAt,
        error: state.error,
        operators: OP_LABEL,
      });
      return;
    }
    if (url.pathname === "/api/suggest") {
      const query = (url.searchParams.get("q") || "").slice(0, 60);
      const operator = url.searchParams.get("op") || "";
      if (operator && !OP_LABEL[operator]) throw new Error("Filtro non valido");
      send(res, 200, await search(query, operator));
      return;
    }
    if (url.pathname === "/api/departures") {
      send(res, 200, await liveDepartures(url.searchParams.get("feed") || "", (url.searchParams.get("ids") || "").split(",").filter(Boolean)));
      return;
    }
    if (url.pathname === "/api/vehicles") {
      send(res, 200, await liveVehicles());
      return;
    }
    if (url.pathname === "/api/route") {
      send(res, 200, routeDetail(url.searchParams.get("feed") || "", url.searchParams.get("id") || "", url.searchParams.get("trip") || ""));
      return;
    }
    if (url.pathname === "/api/stop-lines") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      send(res, 200, { lines: linesAt(url.searchParams.get("feed") || "", ids) });
      return;
    }
    if (url.pathname === "/api/places") {
      const layer = url.searchParams.get("layer") === "bus" ? "bus" : "rail";
      send(res, 200, { layer, stops: mapStops(layer) });
      return;
    }
    if (url.pathname === "/api/fs/stations") {
      const linked = ready() ? linkFsStops() : [];
      send(res, 200, {
        stations: fsStations().map((station) => ({
          ...station,
          schedule: linked.filter((stop) => stop.fsCode === station.code).map((stop) => ({ feed: stop.feed, ids: stop.ids })),
        })),
      });
      return;
    }
    if (url.pathname === "/api/fs/board") {
      send(res, 200, await fsBoard(url.searchParams.get("code") || "", url.searchParams.get("kind") || "partenze"));
      return;
    }
    if (url.pathname === "/api/eav/stations") {
      const stations = await eavStations();
      send(res, 200, {
        stations: stations.map((station) => ({ ...station, schedule: eavStopsFor(station.name) })),
      });
      return;
    }
    if (url.pathname === "/api/eav/board") {
      send(res, 200, await eavBoard(url.searchParams.get("id") || "", url.searchParams.get("kind") || "P"));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "Metodo non permesso" });
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (error) {
    if (!res.headersSent) fail(res, error);
  }
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, "index.html")) {
    send(res, 404, { error: "Non trovato" });
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    send(res, 404, { error: "Non trovato" });
    return;
  }
  if (!info.isFile()) {
    send(res, 404, { error: "Non trovato" });
    return;
  }
  const type = types[path.extname(file)] || "application/octet-stream";
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = { "content-type": type, "cache-control": "no-cache", etag, "last-modified": info.mtime.toUTCString(), vary: "accept-encoding" };
  const ifNoneMatch = res.req.headers["if-none-match"] || "";
  if (ifNoneMatch === "*" || ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const gzip = info.size > 1024 && /text|json|svg/.test(type) && wantsGzip(res);
  if (gzip) headers["content-encoding"] = "gzip";
  else headers["content-length"] = info.size;
  res.writeHead(200, headers);
  if (res.req.method === "HEAD") {
    res.end();
    return;
  }
  if (gzip) pipeline(createReadStream(file), createGzip(), res, () => {});
  else pipeline(createReadStream(file), res, () => {});
}

// As PID 1 (plain docker run, no init) node ignores these unless handled. The build writes to a temp file, so exiting mid-build is safe.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

// Open the on-disk schedule before listening, then check upstream in the background.
await refresh({ offline: true });
createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) fail(res, error);
  });
}).listen(port, host, () => {
  console.log(`banchina in ascolto su ${port}`);
  refresh();
  setInterval(refresh, 6 * 60 * 60 * 1000);
});
