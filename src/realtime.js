import { getBuffer } from "./net.js";
import { decodeFeed } from "./protobuf.js";

const BASE = "https://proxy.busone.app/anm";
const TTL_MS = 10000;
const MAX_AGE_SEC = 90;

const CLIENT = process.env.BUSONE_CLIENT || "Banchina Napoli (uso personale, non commerciale)";
const USE = process.env.BUSONE_USE || "personal";
const HEADERS = { "X-BusOne-Client": CLIENT, "X-BusOne-Use": USE };

const cache = new Map();

function load(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = getBuffer(`${BASE}/gtfs-rt/${name}.pb`, { headers: HEADERS }).then(decodeFeed);
  cache.set(name, { at: Date.now(), promise });
  promise.catch(() => cache.delete(name));
  return promise;
}

export async function vehicles() {
  return vehiclesFrom(await load("vehicle-positions"), Date.now() / 1000);
}

export function vehiclesFrom(feed, nowSec) {
  const list = [];
  for (const entity of feed.entity || []) {
    const v = entity.vehicle;
    const pos = v?.position;
    if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;
    const ageSec = Math.round(nowSec - Number(v.timestamp || 0));
    if (ageSec > MAX_AGE_SEC || ageSec < -60) continue;
    list.push({
      id: v.vehicle?.id || entity.id,
      tripId: v.trip?.tripId || "",
      routeId: v.trip?.routeId || "",
      lat: pos.latitude,
      lon: pos.longitude,
      bearing: Number.isFinite(pos.bearing) ? pos.bearing : null,
      speedKmh: Number.isFinite(pos.speed) ? Math.round(pos.speed * 3.6) : null,
      ageSec: Math.max(0, ageSec),
    });
  }
  return {
    feedTimestamp: Number(feed.header?.timestamp || 0),
    vehicles: list,
  };
}

/** Map of `tripId|stopId` to the predicted arrival, from BusOne TripUpdates. */
export async function predictions() {
  return predictionsFrom(await load("trip-updates"));
}

export function predictionsFrom(feed) {
  const map = new Map();
  for (const entity of feed.entity || []) {
    const update = entity.tripUpdate;
    if (!update) continue;
    const tripId = update.trip?.tripId;
    if (!tripId) continue;
    for (const stop of update.stopTimeUpdate || []) {
      if (stop.scheduleRelationship === "NO_DATA") continue;
      const event = stop.arrival || stop.departure;
      if (!event?.time) continue;
      map.set(`${tripId}|${stop.stopId}`, {
        time: Number(event.time),
        delaySec: Number.isFinite(event.delay) ? event.delay : null,
      });
    }
  }
  return map;
}
