import { state } from "./state.js";
import { OP, LAYERS_KEY, LAYER_DEFAULTS, $, statusEl, vehicleCount, freshEl, freshText, clockTime, api, distanceMeters, escapeHtml } from "./util.js";
import { openFs, openStop } from "./board.js";
import { openRoute } from "./route.js";
import { fitView } from "./ui.js";

const layerState = loadLayers();

const vehicleMarkers = new Map();

let lastVehicles = null;
let lastVehiclesAt = 0;
let freshness = { failed: false, baseAge: 0 };

/* Line badges for a highlighted stop: FS is always L2, the others come from the loaded stop of that kind at the same spot. */
function badgeLines(kind, lat, lon) {
  if (kind === "fs") return ["2"];
  if (!["metro", "eav", "funi"].includes(kind)) return [];
  const near = (window.__rail || []).filter((stop) => stop.l && LANES.stopKind(stop.k, stop.o) === kind && distanceMeters(stop.y, stop.x, lat, lon) < 30);
  return [...new Set(near.flatMap((stop) => stop.l))].sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
}

function focus(lat, lon, label, kind = "bus") {
  if (!state.map || lat == null || lon == null) return;
  fitView(L.latLngBounds([[lat, lon], [lat, lon]]), 16);
  if (state.focusMarker) state.focusMarker.remove();
  state.focusMarker = L.marker([lat, lon], { icon: LANES.stopIcon(kind, "selected", badgeLines(kind, lat, lon)), pane: "stops", zIndexOffset: 1000, keyboard: false }).addTo(state.map);
  if (label) state.focusMarker.bindTooltip(escapeHtml(label), { permanent: false, direction: "top", offset: [0, -14] });
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

let stopScale = 1;

function openMapStop(stop) {
  openStop({ feed: stop.f, ids: [stop.i], name: stop.n, operator: stop.o, lane: LANES.stopKind(stop.k, stop.o), lat: stop.y, lon: stop.x, fsCode: null });
}

function addStops(layer, stops) {
  stops.forEach((stop) => {
    if (stop.o === "fs") return;
    if (!networkOn(stop.o)) return;
    const lane = LANES.stopKind(stop.k, stop.o);
    const flat = lane === "bus" || lane === "ebus";
    const marker = flat
      ? L.circleMarker([stop.y, stop.x], LANES.circleStyle(lane, stopScale))
      : L.marker([stop.y, stop.x], { icon: LANES.stopIcon(lane, "normal", stop.l), pane: "stops", keyboard: false });
    if (flat) marker.lane = lane;
    marker.bindTooltip(`${escapeHtml(stop.n)} · ${escapeHtml(OP[stop.o] || "")}`, flat ? {} : { direction: "top", offset: [0, -12] });
    marker.on("click", () => openMapStop(stop));
    marker.addTo(layer);
  });
}

/* Close zoom: line badges next to the street stops in view (bus, filobus, tram). */
const BADGE_ZOOM = 17;
const STREET = new Set(["bus", "ebus", "fil", "tram"]);

function renderBadges() {
  if (!state.badgeLayer) return;
  state.badgeLayer.clearLayers();
  if (state.map.getZoom() < BADGE_ZOOM || !state.map.hasLayer(state.busLayer)) return;
  const view = state.map.getBounds().pad(0.2);
  [...(window.__bus || []), ...(window.__rail || [])].forEach((stop) => {
    if (!stop.l || !networkOn(stop.o)) return;
    const kind = LANES.stopKind(stop.k, stop.o);
    if (!STREET.has(kind) || !view.contains([stop.y, stop.x])) return;
    L.marker([stop.y, stop.x], { icon: LANES.badgeIcon(kind, stop.l), pane: "stops", interactive: false, keyboard: false }).addTo(state.badgeLayer);
  });
}

function restyleStops() {
  if (!state.busLayer) return;
  state.busLayer.eachLayer((marker) => {
    if (marker.lane) marker.setStyle(LANES.circleStyle(marker.lane, stopScale));
  });
}

function applyFilter() {
  if (!state.railLayer) return;
  state.railLayer.clearLayers();
  state.busLayer.clearLayers();
  if (networkOn("fs")) {
    state.fsStations.forEach((station) => {
      const marker = L.marker([station.lat, station.lon], { icon: LANES.stopIcon("fs", "normal", ["2"]), pane: "stops", keyboard: false });
      marker.bindTooltip(escapeHtml(station.name), { direction: "top", offset: [0, -12] });
      marker.on("click", () => openFs(station));
      marker.addTo(state.railLayer);
    });
  }
  if (window.__rail) addStops(state.railLayer, window.__rail);
  if (window.__bus) addStops(state.busLayer, window.__bus);
  applyMapMode();
  renderBadges();
}

let basemap = null;
let basemapKind = "";

/* MapLibre is only fetched on WebGL2 devices; same SRI hashes as the old static tags. */
const CDN = "https://cdn.jsdelivr.net/npm/";
const MAPLIBRE_CSS = ["maplibre-gl@5.24.1/dist/maplibre-gl.css", "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK"];
const MAPLIBRE_JS = ["maplibre-gl@5.24.1/dist/maplibre-gl.js", "sha384-nXMl9YiLoSG5KBPTFgvxVuIqQQcqIvo0bFrvoEaGJC6r7IibIzF1S36Zbf/sKBtL"];
const BRIDGE_JS = ["@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js", "sha384-tXYNKOHx4T02jMP7YYCtBxPIv1B5gaA5mcVPBzqMp6d7VzWzxJgI2aWF/nJLrQdS"];
const MAPLIBRE_TIMEOUT_MS = 12000;

function loadTag(tag, [path, integrity], attrs) {
  return new Promise((resolve, reject) => {
    const node = Object.assign(document.createElement(tag), attrs, { integrity, crossOrigin: "anonymous", onload: resolve, onerror: reject });
    node[tag === "link" ? "href" : "src"] = CDN + path;
    document.head.append(node);
  });
}

function loadMaplibre() {
  const css = loadTag("link", MAPLIBRE_CSS, { rel: "stylesheet" });
  const js = loadTag("script", MAPLIBRE_JS).then(() => loadTag("script", BRIDGE_JS));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("MapLibre timeout")), MAPLIBRE_TIMEOUT_MS);
  });
  return Promise.race([Promise.all([css, js]), timeout]).finally(() => clearTimeout(timer));
}

/* MapLibre 5 needs WebGL2: a WebGL1-only device goes straight to the raster basemap. */
function webglReady() {
  try {
    return Boolean(window.basemapStyle && document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

function useRasterBasemap() {
  if (basemapKind === "raster") return;
  const old = basemap;
  if (old) {
    // A GL layer that died in onAdd (no GL map) or lost its context can throw in onRemove,
    // which would leave its move/zoom handlers hooked: swallow it so removeLayer finishes.
    const onRemove = old.onRemove;
    old.onRemove = function (map) {
      try {
        onRemove.call(this, map);
      } catch {
        this.getContainer()?.remove();
      }
    };
    state.map.removeLayer(old);
  }
  basemap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(state.map);
  basemapKind = "raster";
  document.documentElement.dataset.basemap = "raster";
}

function useVectorBasemap() {
  if (basemapKind || !window.maplibregl || !L.maplibreGL) return useRasterBasemap();
  try {
    basemap = L.maplibreGL({
      style: window.basemapStyle(isDark() ? "dark" : "light"),
      attributionControl: false,
      fadeDuration: 150,
      maxTileCacheSize: 80,
    });
    basemap.addTo(state.map);
    const glMap = basemap.getMaplibreMap();
    glMap.on("error", (event) => {
      if (event.error && /WebGL|context/i.test(String(event.error.message))) useRasterBasemap();
    });
    // iOS drops the GL context under memory pressure: the raster basemap is final, so no restore loop.
    glMap.getCanvas().addEventListener("webglcontextlost", () => useRasterBasemap(), { once: true });
    basemapKind = "vector";
    document.documentElement.dataset.basemap = "vector";
  } catch {
    useRasterBasemap();
  }
}

function setupBasemap() {
  if (!webglReady()) return useRasterBasemap();
  // Overlays keep working on Leaflet while MapLibre downloads; any load failure or timeout means raster.
  loadMaplibre().then(useVectorBasemap, () => useRasterBasemap());
}

function syncBasemapTheme() {
  if (!state.map || basemapKind !== "vector" || !basemap) return;
  basemap.getMaplibreMap().setStyle(window.basemapStyle(isDark() ? "dark" : "light"));
}

function setupMap() {
  if (!window.L) {
    statusEl.textContent = "Mappa non caricata. Le banchine restano consultabili.";
    return;
  }
  state.map = L.map("map", { preferCanvas: true, renderer: L.canvas({ tolerance: 8 }), zoomControl: false, attributionControl: false }).setView([40.845, 14.25], window.innerWidth > 860 ? 13 : 12);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  setupBasemap();
  window.addEventListener("resize", () => state.map.invalidateSize());
  state.map.createPane("stops").style.zIndex = 590;
  state.railLayer = L.layerGroup().addTo(state.map);
  state.busLayer = L.layerGroup().addTo(state.map);
  state.badgeLayer = L.layerGroup().addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.vehicleLayer = L.layerGroup().addTo(state.map);
  const syncZoom = () => {
    const mapNode = document.querySelector("#map");
    mapNode.classList.toggle("zoom-far", state.map.getZoom() < 15);
    mapNode.classList.toggle("zoom-mid", state.map.getZoom() < 16);
    mapNode.classList.toggle("zoom-dot", state.map.getZoom() < 13);
    const scale = LANES.stopScale(state.map.getZoom());
    mapNode.style.setProperty("--ss", scale);
    if (scale !== stopScale) {
      stopScale = scale;
      restyleStops();
    }
  };
  state.map.on("zoomend", syncZoom);
  state.map.on("moveend", renderBadges);
  syncZoom();
  applyFilter();
  refreshVehicles();
  setInterval(refreshVehicles, 10000);
  setInterval(renderFreshness, 10000);
}

const COMPASS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"];

function vehicleKind(vehicle) {
  return LANES.routeKind(vehicle.route?.typeLabel, vehicle.operator || vehicle.route?.operator);
}

function vehicleLabel(vehicle) {
  const kind = vehicleKind(vehicle);
  return vehicle.route?.short || (kind === "bus" || kind === "ebus" || kind === "fil" ? "ANM" : "MET");
}

function vehicleIcon(label, kind = "bus") {
  const shown = label.length > 4 ? label.slice(0, 4) : label;
  return L.divIcon({
    className: `veh-wrap k-${kind} l-${Math.min(shown.length, 4)}`,
    html: LANES.vehHtml(kind, escapeHtml(shown)),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function vehicleDetails(vehicle, label) {
  const heading = vehicle.headsign
    ? `verso ${vehicle.headsign}`
    : vehicle.bearing != null ? `direzione ${COMPASS[Math.round(vehicle.bearing / 45) % 8]}` : null;
  const lines = [
    `<strong>Linea ${escapeHtml(label)}</strong>${vehicle.route?.typeLabel ? ` · ${escapeHtml(vehicle.route.typeLabel)}` : ""}`,
    heading ? escapeHtml(heading) : null,
    [vehicle.speedKmh != null ? `${escapeHtml(vehicle.speedKmh)} km/h` : null, `GPS ${escapeHtml(vehicle.ageSec)} s fa`].filter(Boolean).join(" · "),
  ];
  return lines.filter(Boolean).map((line) => `<div>${line}</div>`).join("");
}

function turnCone(entry, bearing) {
  const node = entry.marker.getElement();
  if (!node) return;
  const cone = node.querySelector(".cone");
  node.classList.toggle("has-heading", bearing != null);
  if (bearing == null) return;
  let turn = bearing;
  if (entry.turn != null) {
    const delta = ((bearing - entry.turn) % 360 + 540) % 360 - 180;
    turn = entry.turn + delta;
  }
  entry.turn = turn;
  cone.style.setProperty("--hd", `${turn.toFixed(1)}deg`);
}

function syncVehicleSelection() {
  const id = state.selection?.type === "route" ? state.selection.vehicle?.id ?? null : null;
  vehicleMarkers.forEach((entry, key) => {
    const picked = key === id;
    entry.marker.getElement()?.classList.toggle("picked", picked);
    entry.marker.setZIndexOffset(picked ? 1000 : 0);
  });
}

function mapMode() {
  if (state.selection && state.selection.type === "route") {
    return { name: "path", feed: state.selection.route.feed, routeId: state.selection.route.id };
  }
  if (state.selection && state.board) {
    const lines = (state.board.lines || []).filter((line) => line.feed === "anm").map((line) => line.id);
    return { name: "stop", routeIds: new Set(lines) };
  }
  return { name: "normal" };
}

function vehicleShown(vehicle, mode) {
  if (mode.name === "normal") return true;
  if (!vehicle.routeId) return false;
  if (mode.name === "path") return mode.feed === "anm" && vehicle.routeId === mode.routeId;
  return mode.routeIds.has(vehicle.routeId);
}

function otherDirection(vehicle, mode) {
  if (mode.name !== "path" || vehicle.direction == null) return false;
  const current = state.selection.route.directions[state.selection.dir];
  if (!current || current.direction == null) return false;
  const own = String(vehicle.direction);
  return state.selection.route.directions.some((item) => String(item.direction) === own) && own !== String(current.direction);
}

function applyMapMode() {
  if (!state.map) return;
  const mode = mapMode();
  const stopsVisible = mode.name === "normal";
  [state.railLayer, state.busLayer, state.badgeLayer].forEach((layer) => {
    if (state.map.hasLayer(layer) !== stopsVisible) {
      if (stopsVisible) state.map.addLayer(layer);
      else state.map.removeLayer(layer);
    }
  });
  if (!stopsVisible && (!lastVehicles || Date.now() - lastVehiclesAt > 15000)) {
    lastVehicles = null;
    refreshVehicles();
    return;
  }
  renderVehicles();
}

async function refreshVehicles() {
  if (!state.vehicleLayer) return;
  if (!vehiclesOn() && mapMode().name === "normal") {
    renderVehicles();
    return;
  }
  try {
    lastVehicles = await api("/api/vehicles?feed=anm");
    lastVehiclesAt = Date.now();
    freshness = { failed: false, baseAge: feedAgeSec(lastVehicles) };
    renderVehicles();
  } catch (error) {
    vehicleCount.textContent = error.message;
    freshness = { ...freshness, failed: true };
    renderFreshness();
  }
}

function renderVehicles() {
  if (!state.vehicleLayer) return;
  const mode = mapMode();
  if (mode.name === "normal" && !vehiclesOn()) {
    state.vehicleLayer.clearLayers();
    vehicleMarkers.clear();
    vehicleCount.textContent = "";
    renderFreshness();
    return;
  }
  const data = lastVehicles;
  if (!data) return;
  try {
    const seen = new Set();
    const shown = data.vehicles.filter((vehicle) => vehicleShown(vehicle, mode));
    shown.forEach((vehicle) => {
      const label = vehicleLabel(vehicle);
      const kind = vehicleKind(vehicle);
      const sig = `${label}|${kind}`;
      seen.add(vehicle.id);
      let entry = vehicleMarkers.get(vehicle.id);
      if (!entry) {
        const marker = L.marker([vehicle.lat, vehicle.lon], { icon: vehicleIcon(label, kind) }).bindTooltip(vehicleDetails(vehicle, label), { className: "veh-tip", direction: "top", offset: [0, -16] });
        entry = { marker, label: sig, turn: null, data: vehicle };
        marker.on("click", () => {
          const current = entry.data;
          if (!current.routeId) return;
          openRoute(
            { feed: "anm", id: current.routeId },
            { tripId: current.tripId, vehicle: { id: current.id, ageSec: current.ageSec } },
          );
        });
        marker.addTo(state.vehicleLayer);
        vehicleMarkers.set(vehicle.id, entry);
      } else {
        entry.data = vehicle;
        entry.marker.setLatLng([vehicle.lat, vehicle.lon]);
        if (entry.label !== sig) {
          entry.label = sig;
          entry.marker.setIcon(vehicleIcon(label, kind));
          entry.turn = null;
        }
        entry.marker.setTooltipContent(vehicleDetails(vehicle, label));
      }
      turnCone(entry, vehicle.bearing);
    });
    vehicleMarkers.forEach((entry, id) => {
      if (seen.has(id)) return;
      entry.marker.remove();
      vehicleMarkers.delete(id);
    });
    shown.forEach((vehicle) => {
      vehicleMarkers.get(vehicle.id)?.marker.getElement()?.classList.toggle("other-dir", otherDirection(vehicle, mode));
    });
    syncVehicleSelection();
    const scope = mode.name === "path" ? " della linea" : mode.name === "stop" ? " di questa fermata" : "";
    vehicleCount.textContent = `${shown.length} mezzi${scope} · aggiornato ${clockTime(new Date(data.updatedAt))}`;
    renderFreshness();
  } catch (error) {
    vehicleCount.textContent = error.message;
  }
}

function feedAgeSec(data) {
  const sent = Date.parse(data.updatedAt);
  if (data.feedTimestamp && Number.isFinite(sent)) return Math.max(0, Math.round((sent - data.feedTimestamp * 1000) / 1000));
  const ages = data.vehicles.map((vehicle) => vehicle.ageSec).filter((age) => Number.isFinite(age)).sort((a, b) => a - b);
  return ages.length ? ages[0] : 0;
}

function ageText(seconds) {
  if (seconds < 60) return `Dati di ${Math.max(5, Math.round(seconds / 5) * 5)}s fa`;
  if (seconds < 3600) return `Dati di ${Math.floor(seconds / 60)}m fa`;
  return `Dati di ${Math.floor(seconds / 3600)}h fa`;
}

function renderFreshness() {
  if (!freshEl) return;
  const hidden = mapMode().name === "normal" && !vehiclesOn();
  freshEl.hidden = hidden;
  if (hidden) return;
  if (!lastVehicles) {
    freshEl.dataset.state = freshness.failed ? "error" : "idle";
    freshText.textContent = freshness.failed ? "Dati non disponibili" : "Dati in arrivo";
    return;
  }
  const age = freshness.baseAge + (Date.now() - lastVehiclesAt) / 1000;
  const state = freshness.failed ? "error" : age > 60 ? "stale" : "fresh";
  freshEl.dataset.state = state;
  freshText.textContent = freshness.failed ? `Aggiornamento fallito · ${ageText(age).toLowerCase()}` : ageText(age);
}

async function loadPlaces() {
  const rail = await api("/api/places?layer=rail");
  window.__rail = rail.stops;
  applyFilter();
}

function loadLayers() {
  const state = { ...LAYER_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYERS_KEY));
    if (saved && typeof saved === "object") {
      Object.keys(LAYER_DEFAULTS).forEach((key) => {
        if (typeof saved[key] === "boolean") state[key] = saved[key];
      });
    }
  } catch {
    /* no saved layers, or storage is blocked: use the defaults */
  }
  return state;
}

function saveLayers() {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(layerState));
  } catch {
    /* the choice just will not be remembered */
  }
}

function networkOn(operator) {
  return layerState[operator] !== false;
}

function vehiclesOn() {
  return layerState.vehicles && networkOn("anm");
}

function layersEmptyReason() {
  const networks = ["anm", "eav-rail", "eav-bus", "fs"];
  if (!networks.some(networkOn)) return "Nessuna rete attiva";
  return "";
}

async function ensureBusStops() {
  if (window.__bus) return true;
  statusEl.textContent = "Carico le fermate di superficie…";
  try {
    const body = await api("/api/places?layer=bus");
    window.__bus = body.stops;
    statusEl.textContent = "";
    return true;
  } catch (error) {
    statusEl.textContent = error.message;
    return false;
  }
}

function syncLayerControls() {
  document.querySelectorAll("#layers-panel [data-layer]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Boolean(layerState[button.dataset.layer])));
  });
  const reason = layersEmptyReason();
  const custom = Object.keys(LAYER_DEFAULTS).some((key) => layerState[key] !== LAYER_DEFAULTS[key]);
  const button = $("#layers-btn");
  button.toggleAttribute("data-empty", Boolean(reason));
  button.toggleAttribute("data-custom", custom && !reason);
  $("#layers-cue").textContent = reason;
  $("#layers-cue").hidden = !reason;
  $("#layers-hint").textContent = !reason ? "" : "La mappa resta vuota: accendi almeno una rete.";
  $("#layers-hint").hidden = !reason;
  $("#layers-needs-anm").hidden = !layerState.vehicles || networkOn("anm");
}

async function setLayer(key, value) {
  layerState[key] = value;
  saveLayers();
  syncLayerControls();
  // ponytail: bus stops follow their network toggle (ANM, EAV bus); addStops filters by operator
  if ((key === "anm" || key === "eav-bus") && value) await ensureBusStops();
  if (key === "vehicles" || key === "anm") {
    if (vehiclesOn()) refreshVehicles();
    else renderVehicles();
  }
  if (key !== "vehicles") applyFilter();
  else renderFreshness();
}

function setupLayers() {
  const button = $("#layers-btn");
  const panel = $("#layers-panel");
  const box = $(".layers");
  const close = (focusButton = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
  panel.querySelectorAll("[data-layer]").forEach((toggle) => {
    toggle.addEventListener("click", () => setLayer(toggle.dataset.layer, !layerState[toggle.dataset.layer]));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !box.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      close(true);
    }
  });
  syncLayerControls();
  if (networkOn("anm") || networkOn("eav-bus")) {
    ensureBusStops().then((ok) => {
      if (ok) applyFilter();
    });
  }
}

// Kept global as in the old classic app.js: smoke tests force the raster fallback via page.evaluate("useRasterBasemap()").
window.useRasterBasemap = useRasterBasemap;

export { focus, syncVehicleSelection, applyMapMode, badgeLines, applyFilter, syncBasemapTheme, setupMap, loadPlaces, setupLayers };
