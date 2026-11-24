import { state } from "./state.js";
import { OP, POLL_MS, RECENT_KEY, $, query, results, work, statusEl, el, minutesUntil, clockTime, api, delayLabel, when, setLineKind, badge, distanceMeters, formatDistance, loose } from "./util.js";
import { openRoute, paintRoute } from "./route.js";
import { renderResults } from "./search.js";
import { focus, syncVehicleSelection, applyMapMode } from "./map.js";
import { setSnap, setCollapsed, homeCollapsedPref, fitView } from "./ui.js";

let userMarker;

const linesCache = new Map();

let boardSeq = 0;

function boardKind(sel) {
  if (sel.type === "fs") return "fs";
  if (sel.type === "eav") return "eav";
  return sel.kind || LANES.operatorKind(sel.operator);
}

function remember(kind, data, label, hint) {
  const key = `${kind}:${data.code || data.id || `${data.feed}:${(data.ids || []).join(",")}`}`;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    list = [];
  }
  list = [{ key, kind, data, label, hint, at: Date.now() }, ...list.filter((item) => item.key !== key)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage can be disabled; recents are a convenience */
  }
}

function recents() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function reopen(item) {
  if (item.kind === "fs") openFs(item.data);
  else if (item.kind === "eav") openEav(item.data, item.data.schedule);
  else openStop(item.data);
}

function renderHome() {
  const home = el("div", { class: "home" });
  const list = recents();
  if (!list.length) {
    home.append(el("p", { class: "lede" }, ["Cerca una fermata, una stazione o una linea. Oppure tocca la mappa, o il mirino per le fermate vicine a te."]));
  } else {
    home.append(el("h3", {}, ["Recenti"]));
    const ul = el("ul", { class: "recent-list" });
    list.forEach((item) => {
      ul.append(el("li", {}, [
        el("button", { type: "button", onclick: () => reopen(item) }, [
          el("span", { class: "nm" }, [item.label]),
          el("span", { class: "hint" }, [item.hint]),
        ]),
      ]));
    });
    home.append(ul);
  }

  work.replaceChildren(home);
  setCollapsed(homeCollapsedPref());
  setLineKind(null);
}

function paint() {
  syncVehicleSelection();
  if (!state.selection) {
    renderHome();
    return;
  }
  if (state.selection.type === "route") {
    paintRoute();
    return;
  }
  renderBoard();
}

function backButton(handler) {
  return el("button", {
    class: "back",
    type: "button",
    "aria-label": "Chiudi",
    onclick: (event) => {
      event.stopPropagation();
      (handler || closeBoard)();
    },
  }, ["\u00d7"]);
}

function renderBoard() {
  const sel = state.selection;
  const head = el("div", { class: "head" });
  const titles = el("div", { class: "titles" });
  titles.append(el("h2", {}, [sel.name]));
  titles.append(el("p", { class: "sub" }, [sel.sub]));
  const stamp = el("p", { class: "stamp-time under" });
  head.append(titles, backButton());

  const kinds = sel.type === "fs" || sel.type === "eav"
    ? el("div", { class: "seg", role: "group", "aria-label": "Tipo di banchina" }, [
      el("button", { type: "button", class: state.board.kind === "partenze" ? "on" : "", onclick: () => setKind("partenze") }, ["Partenze"]),
      el("button", { type: "button", class: state.board.kind === "arrivi" ? "on" : "", onclick: () => setKind("arrivi") }, ["Arrivi"]),
    ])
    : null;

  const strip = el("div", { class: "line-strip", id: "strip" });
  const body = el("div", { class: "body", id: "body" });
  work.replaceChildren(...[head, strip, kinds, stamp, body].filter(Boolean));
  setLineKind(boardKind(sel));
  state.board.stamp = stamp;
  renderBody();
  renderStamp();
  fillStrip();
}

function stopIdsOf(sel) {
  if (!sel) return [];
  if (sel.schedule && sel.schedule.ids) return sel.schedule.ids;
  if (sel.type === "stop") return sel.ids || [];
  return [];
}

function lineSource(sel) {
  if (sel.schedule && sel.schedule.ids) return sel.schedule;
  if (sel.type === "stop") return { feed: sel.feed, ids: sel.ids };
  return null;
}

function fillStrip() {
  const strip = $("#strip");
  if (!strip) return;
  if (!state.board || !state.board.lines || !state.board.lines.length) {
    strip.replaceChildren();
    return;
  }
  const here = stopIdsOf(state.selection);
  const chips = el("div", { class: "strip-chips" });
  state.board.lines.forEach((line) => {
    chips.append(el("button", {
      type: "button",
      class: "line-chip kb",
      "data-k": LANES.routeKind(line.typeLabel, line.operator),
      title: line.long || line.short,
      onclick: () => openRoute({ feed: line.feed, id: line.id }, { here }),
    }, [line.short || line.long]));
  });
  strip.replaceChildren(el("p", { class: "strip-title" }, [state.board.lines.length > 1 ? `Percorsi · ${state.board.lines.length} linee` : "Percorsi"]), chips);
}

function restoreBoard(sel) {
  setSnap("peek");
  startBoard(sel);
  if (sel.lat != null) focus(sel.lat, sel.lon, sel.name, boardKind(sel));
}

function renderStamp() {
  if (!state.board || !state.board.stamp) return;
  if (state.board.live.at) {
    state.board.stamp.textContent = state.board.live.error
      ? `Ultimo dato alle ${clockTime(state.board.live.at)}`
      : `Aggiornato alle ${clockTime(state.board.live.at)}`;
    state.board.stamp.classList.toggle("stale", Boolean(state.board.live.error));
  } else {
    state.board.stamp.textContent = state.board.live.error ? "" : "Caricamento…";
    state.board.stamp.classList.remove("stale");
  }
}

function renderBody() {
  const body = $("#body");
  if (!body || !state.board) return;
  const sel = state.selection;
  const mode = sel.type === "fs" ? "fs" : sel.type === "eav" ? "eav" : "sched";
  const nodes = [];

  if (state.board.live.error) {
    const retry = el("div", { class: "retry", role: "alert" }, [
      el("b", {}, ["Diretta non disponibile. "]),
      state.board.live.error,
      el("button", { type: "button", onclick: () => refreshLive(true) }, ["Riprova"]),
    ]);
    nodes.push(retry);
  }

  if (state.board.live.rows === null && !state.board.live.error) {
    nodes.push(el("span", { class: "skeleton" }), el("span", { class: "skeleton" }), el("span", { class: "skeleton" }));
  } else if (state.board.live.rows) {
    if (state.board.live.rows.length) nodes.push(rowsEl(state.board.live.rows.slice(0, 14), mode));
    else nodes.push(el("p", { class: "empty" }, ["Nessuna corsa nelle prossime ore."]));
    if (state.board.note) nodes.push(el("p", { class: "note" }, [state.board.note]));
  }

  if (state.board.sched.rows && sel.type !== "stop") {
    nodes.push(el("p", { class: "subhead" }, ["Orario pubblicato"]));
    nodes.push(state.board.sched.rows.length
      ? rowsEl(state.board.sched.rows.slice(0, 8), "sched")
      : el("p", { class: "empty" }, ["Nessuna corsa pubblicata per questa fermata."]));
  }

  nodes.push(el("p", { class: "note" }, [stopNote(sel)]));
  body.replaceChildren(...nodes);
}

function stopNote(sel) {
  if (sel.type === "fs") return "Solo i treni della Linea 2, da Pozzuoli a San Giovanni a Barra. I regionali che proseguono fuori città restano fuori.";
  if (sel.operator === "anm") {
    return state.board.realtime && state.board.realtime.ok
      ? "Orario GTFS di ANM con previsioni BusOne: «prev.» è la previsione, «prog.» l’orario programmato."
      : "Orario GTFS di ANM. Previsioni BusOne non disponibili in questo momento.";
  }
  if (sel.operator === "eav-bus") return "Orario GTFS di EAV bus. Nessun dato in tempo reale per questa rete.";
  if (sel.type === "eav") return "Dati dal teleindicatore di stazione EAV.";
  return "Orario GTFS pubblicato.";
}

function rowsEl(rows, mode) {
  const wrap = el("div", { class: "rows" });
  rows.forEach((row) => {
    let minutes = row.inMinutes;
    if (minutes == null && mode !== "sched") minutes = minutesUntil(row.time);
    const live = mode === "sched" && row.live;
    const delay = live ? delayLabel(row.delayMin) : delayLabel(row.delay);

    const main = el("div", { class: "main" });
    if (mode === "sched") {
      main.append(el("div", { class: "dest" }, [
        badge("span", "badge", LANES.routeKind(row.typeLabel, row.operator), [row.short || row.typeLabel]),
        row.headsign || row.long || "Corsa",
      ]));
      main.append(el("em", {}, [row.typeLabel]));
    } else if (mode === "eav") {
      main.append(el("div", { class: "dest" }, [row.destination || ""]));
      main.append(el("em", {}, [[row.train, row.category, row.info].filter(Boolean).join(" · ")]));
    } else {
      main.append(el("div", { class: "dest" }, [row.place || ""]));
      main.append(el("em", {}, [[row.category, row.train].filter(Boolean).join(" ")]));
    }

    const timeChildren = [row.time || "—"];
    if (live) timeChildren.push(el("small", {}, [`prev. ${when(minutes)}`.trim()]));
    else if (minutes != null) timeChildren.push(el("small", {}, [when(minutes)]));
    const time = el("div", { class: "time" }, timeChildren);

    const side = el("div", { class: "side" });
    if (row.platform) side.append(el("span", { class: "plat" }, [`bin ${row.platform}`]));
    if (delay) side.append(el("span", { class: delay.className }, [delay.text]));
    if (live && row.scheduled) side.append(el("span", { class: "prog" }, [`prog. ${row.scheduled}`]));

    const tappable = mode === "sched" && Boolean(row.routeId);
    if (tappable) side.append(el("span", { class: "go", "aria-hidden": "true" }, ["\u203a"]));
    const attrs = { class: `row${minutes != null && minutes <= 1 ? " now" : ""}${tappable ? " tap" : ""}` };
    if (tappable) {
      attrs.type = "button";
      attrs.title = "Mostra il percorso";
      attrs.onclick = () => openRoute({ feed: row.feed, id: row.routeId }, { tripId: row.tripId, here: stopIdsOf(state.selection) });
    }
    wrap.append(el(tappable ? "button" : "div", attrs, [time, main, side]));
  });
  return wrap;
}

async function loadLive(sel, kind) {
  if (sel.type === "fs") {
    const data = await api(`/api/fs/board?code=${encodeURIComponent(sel.code)}&kind=${kind === "arrivi" ? "arrivi" : "partenze"}`);
    return { rows: data.rows, note: data.note };
  }
  if (sel.type === "eav") {
    const data = await api(`/api/eav/board?id=${encodeURIComponent(sel.id)}&kind=${kind === "arrivi" ? "A" : "P"}`);
    return { rows: data.rows, note: null };
  }
  const data = await api(`/api/departures?feed=${sel.feed}&ids=${encodeURIComponent(sel.ids.join(","))}`);
  return { rows: data.rows, realtime: data.realtime, note: null, departures: true };
}

async function loadSchedule(sel) {
  if (!sel.schedule) return null;
  const data = await api(`/api/departures?feed=${sel.schedule.feed}&ids=${encodeURIComponent(sel.schedule.ids.join(","))}`);
  return data.rows;
}

async function refreshLive(manual = false) {
  if (!state.board || !state.selection || state.selection.type === "route") return;
  if (state.board.inflight && !manual) return;
  const token = state.board.token;
  const sel = state.selection;
  state.board.inflight = true;
  try {
    const data = await loadLive(sel, state.board.kind);
    if (token !== state.board?.token) return;
    state.board.live = { rows: data.rows, at: new Date(), error: null };
    state.board.note = data.note || null;
    if (data.departures) state.board.realtime = data.realtime;
  } catch (error) {
    if (token !== state.board?.token) return;
    state.board.live = { ...state.board.live, error: error.message };
  } finally {
    if (token === state.board?.token) state.board.inflight = false;
  }
  if (token !== state.board?.token) return;
  if (!$("#body")) renderBoard();
  else {
    renderBody();
    renderStamp();
  }
}

function startBoard(sel) {
  clearInterval(state.poll);
  clearTimeout(state.searchTimer);
  state.searchGeneration += 1;
  state.board = {
    token: ++boardSeq,
    kind: "partenze",
    live: { rows: null, at: null, error: null },
    sched: { rows: null, error: null },
    lines: null,
    note: null,
    realtime: null,
    inflight: false,
    stamp: null,
  };
  state.selection = sel;
  if (state.routeLayer) state.routeLayer.clearLayers();
  const source = lineSource(sel);
  const linesKey = source ? `${source.feed}|${source.ids.join(",")}` : "";
  state.board.lines = linesCache.get(linesKey) || null;
  renderBoard();
  work.scrollTop = 0;
  applyMapMode();
  const token = state.board.token;
  if (source) {
    api(`/api/stop-lines?feed=${source.feed}&ids=${encodeURIComponent(source.ids.join(","))}`)
      .then((data) => {
        if (token !== state.board?.token) return;
        linesCache.set(linesKey, data.lines);
        state.board.lines = data.lines;
        fillStrip();
        applyMapMode();
      })
      .catch(() => {});
  }
  loadSchedule(sel)
    .then((rows) => {
      if (token === state.board?.token) {
        state.board.sched.rows = rows;
        renderBody();
      }
    })
    .catch(() => {
      if (token === state.board?.token) state.board.sched.rows = [];
    });
  refreshLive(true);
  state.poll = setInterval(() => refreshLive(), POLL_MS);
}

function setKind(kind) {
  if (!state.board) return;
  state.board.kind = kind;
  state.board.token = ++boardSeq;
  state.board.live = { rows: null, at: null, error: null };
  state.board.inflight = false;
  renderBoard();
  refreshLive(true);
}

function closeBoard() {
  state.selection = null;
  state.board = null;
  clearInterval(state.poll);
  if (state.routeLayer) state.routeLayer.clearLayers();
  if (state.focusMarker) state.focusMarker.remove();
  applyMapMode();
  if (state.lastPayload && query.value.trim().length >= 2) {
    renderResults(state.lastPayload);
  } else {
    results.hidden = true;
  }
  setSnap("peek");
  paint();
}

function openFs(station) {
  const schedule = Array.isArray(station.schedule) ? station.schedule[0] || null : station.schedule || null;
  results.hidden = true;
  remember("fs", { ...station, schedule }, station.name, "FS Linea 2 · diretta");
  setSnap("peek");
  startBoard({
    type: "fs",
    operator: "fs",
    code: station.code,
    name: station.name,
    sub: "FS Linea 2 · diretta ViaggiaTreno",
    schedule,
    lat: station.lat,
    lon: station.lon,
  });
  focus(station.lat, station.lon, station.short || station.name, "fs");
}

function openEav(station, schedule) {
  const resolved = schedule || station.schedule || null;
  results.hidden = true;
  remember("eav", { ...station, schedule: resolved }, station.name, `EAV treni · ${(station.lines || [])[0] || "teleindicatore"}`);
  setSnap("peek");
  startBoard({
    type: "eav",
    operator: "eav-rail",
    id: station.id,
    name: station.name,
    sub: `EAV treni · ${(station.lines || []).slice(0, 2).join(" · ") || "teleindicatore"}`,
    schedule: resolved,
  });
}

async function openStop(stop) {
  if (stop.operator === "fs" && stop.fsCode) {
    const station = state.fsStations.find((item) => item.code === stop.fsCode);
    if (station) {
      openFs({ ...station, schedule: [{ feed: stop.feed, ids: stop.ids }] });
      return;
    }
  }
  if (stop.operator === "eav-rail") {
    const live = state.eavStations.find((station) => loose(station.name) === loose(stop.name));
    if (live) {
      openEav(live, { feed: stop.feed, ids: stop.ids });
      focus(stop.lat, stop.lon, stop.name, "eav");
      return;
    }
  }
  results.hidden = true;
  const lane = stop.lane || LANES.stopKind(typeof stop.kind === "number" ? stop.kind : null, stop.operator);
  remember("stop", stop, stop.name, OP[stop.operator] || "Fermata");
  setSnap("peek");
  startBoard({
    type: "stop",
    kind: lane,
    operator: stop.operator,
    feed: stop.feed,
    ids: stop.ids,
    name: stop.name,
    sub: OP[stop.operator] || "Orario",
    lat: stop.lat,
    lon: stop.lon,
    schedule: null,
  });
  focus(stop.lat, stop.lon, stop.name, lane);
}

function nearStop(stop) {
  const kind = LANES.stopKind(stop.k, stop.o);
  return {
    name: stop.n, operator: stop.o, kind, lat: stop.y, lon: stop.x,
    open: () => openStop({ feed: stop.f, ids: [stop.i], name: stop.n, operator: stop.o, lane: kind, lat: stop.y, lon: stop.x }),
  };
}

function showUser(lat, lon, zoom) {
  if (!state.map) return;
  if (userMarker) userMarker.remove();
  userMarker = L.circleMarker([lat, lon], { radius: 7, color: "#ffffff", weight: 3, fillColor: "#1d4ed8", fillOpacity: 1 }).addTo(state.map);
  fitView(L.latLngBounds([[lat, lon], [lat, lon]]), zoom);
}

// One entry point for "where am I": always centres the map; on the home or nearby view it also
// lists the closest stops. Elsewhere (an open board or route) it only moves the map, so the
// traveller does not lose what they were reading.
function locateMe(button) {
  if (!navigator.geolocation) {
    statusEl.textContent = "Questo browser non fornisce la posizione.";
    return;
  }
  const listNearby = Boolean(work.querySelector(".home, .near"));
  button.setAttribute("aria-busy", "true");
  if (listNearby) statusEl.textContent = "Cerco le fermate vicine…";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      if (listNearby) await showNearby(latitude, longitude);
      button.removeAttribute("aria-busy");
      statusEl.textContent = "";
      showUser(latitude, longitude, 16);
    },
    (error) => {
      button.removeAttribute("aria-busy");
      statusEl.textContent = error.code === error.PERMISSION_DENIED
        ? "Posizione negata. Consenti l'accesso alla posizione nelle impostazioni del browser."
        : "Posizione non disponibile. Cerca la fermata per nome.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}

async function showNearby(latitude, longitude) {
  try {
    if (!window.__bus) {
      const body = await api("/api/places?layer=bus");
      window.__bus = body.stops;
    }
  } catch {
    window.__bus = window.__bus || [];
  }
  const candidates = [
    ...state.fsStations.map((station) => ({ name: station.name, operator: "fs", kind: "fs", lat: station.lat, lon: station.lon, open: () => openFs(station) })),
    ...(window.__rail || []).filter((stop) => stop.o !== "fs").map((stop) => nearStop(stop)),
    ...(window.__bus || []).map((stop) => nearStop(stop)),
  ]
    .map((item) => ({ ...item, meters: distanceMeters(latitude, longitude, item.lat, item.lon) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 10);

  const list = el("ul", { class: "near-list" });
  candidates.forEach((item) => {
    list.append(el("li", {}, [
      el("button", { type: "button", onclick: item.open }, [
        el("span", {}, [el("span", { class: "nm" }, [item.name]), " ", badge("span", "op-tag", item.kind, [OP[item.operator] || item.operator])]),
        el("span", { class: "d" }, [formatDistance(item.meters)]),
      ]),
    ]));
  });
  state.selection = null;
  syncVehicleSelection();
  state.board = null;
  clearInterval(state.poll);
  if (state.routeLayer) state.routeLayer.clearLayers();
  applyMapMode();
  const view = el("div", { class: "near" }, [
    el("div", { class: "head" }, [el("div", { class: "titles" }, [el("h2", {}, ["Vicino a te"]), el("p", { class: "sub" }, ["Le fermate più vicine alla tua posizione."])]), backButton()]),
    list,
  ]);
  work.replaceChildren(view);
  setCollapsed(false);
  setSnap("peek");
  setLineKind(null);
}

export { locateMe, backButton, restoreBoard, openStop, openFs, openEav, fillStrip, renderHome };
