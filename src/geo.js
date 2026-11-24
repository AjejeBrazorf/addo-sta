/** Equirectangular distance in metres; plenty for the few hundred metres we compare in Naples. */
export function metres(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 111320;
  const dx = (bLon - aLon) * 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingBetween(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}
