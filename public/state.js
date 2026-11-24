/* Mutable state shared across modules (was module-level lets in app.js). */
export const state = {
  selection: null,
  fsStations: [],
  eavStations: [],
  poll: 0,
  map: undefined,
  railLayer: undefined,
  busLayer: undefined,
  badgeLayer: undefined,
  vehicleLayer: undefined,
  routeLayer: undefined,
  focusMarker: undefined,
  lastPayload: null,
  searchTimer: 0,
  searchGeneration: 0,
  board: null,
};
