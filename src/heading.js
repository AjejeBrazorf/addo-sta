import { bearingBetween, metres } from "./geo.js";
import { tripBearing } from "./schedule.js";

const MOVE_MIN_M = 12;
const HEADING_KEEP_MS = 5 * 60 * 1000;
const FORGET_MS = 15 * 60 * 1000;

const tracks = new Map();

function prune(now) {
  for (const [id, track] of tracks) if (now - track.seen > FORGET_MS) tracks.delete(id);
}

/**
 * Adds `bearing` and `bearingSource` ("feed" | "movement" | "route" | null) to every vehicle.
 * Idempotent for repeated calls with the same positions, so several clients can poll.
 */
export function withHeadings(list, now = Date.now()) {
  prune(now);
  return list.map((vehicle) => {
    const track = tracks.get(vehicle.id);
    let bearing = null;
    let source = null;
    let next = track || { lat: vehicle.lat, lon: vehicle.lon, bearing: null, source: null, at: 0, seen: now };

    if (Number.isFinite(vehicle.bearing)) {
      bearing = vehicle.bearing;
      source = "feed";
      next = { lat: vehicle.lat, lon: vehicle.lon, bearing, source, at: now, seen: now };
    } else {
      if (track && metres(track.lat, track.lon, vehicle.lat, vehicle.lon) >= MOVE_MIN_M) {
        bearing = bearingBetween(track.lat, track.lon, vehicle.lat, vehicle.lon);
        source = "movement";
        next = { lat: vehicle.lat, lon: vehicle.lon, bearing, source, at: now, seen: now };
      } else if (track && track.bearing != null && now - track.at < HEADING_KEEP_MS) {
        bearing = track.bearing;
        source = track.source;
        next = { ...track, seen: now };
      }
      if (bearing == null) {
        let guess = null;
        try {
          guess = tripBearing("anm", vehicle.tripId, vehicle.lat, vehicle.lon);
        } catch {
          guess = null;
        }
        if (guess != null) {
          bearing = guess;
          source = "route";
          next = { lat: vehicle.lat, lon: vehicle.lon, bearing, source, at: now, seen: now };
        } else {
          next = { ...next, lat: track ? track.lat : vehicle.lat, lon: track ? track.lon : vehicle.lon, seen: now };
        }
      }
    }
    tracks.set(vehicle.id, next);
    return { ...vehicle, bearing: bearing == null ? null : Math.round(bearing * 10) / 10, bearingSource: source };
  });
}
