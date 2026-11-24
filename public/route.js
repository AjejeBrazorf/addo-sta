import { state } from "./state.js";
import { OP, $, results, work, el, api, setLineKind, badge, distanceMeters, escapeHtml } from "./util.js";
import { backButton, restoreBoard, openStop } from "./board.js";
import { badgeLines, syncVehicleSelection, applyMapMode } from "./map.js";
import { setSnap, fitView } from "./ui.js";

async function openRoute(item, opts = {}) {
  results.hidden = true;
  clearTimeout(state.searchTimer);
  state.searchGeneration += 1;
  setSnap("peek");
  const prev = state.selection && state.selection.type !== "route" ? state.selection : null;
  const back = opts.back || (prev ? () => restoreBoard(prev) : null);
  try {
    const trip = opts.tripId ? `&trip=${encodeURIComponent(opts.tripId)}` : "";
    const route = await api(`/api/route?feed=${item.feed}&id=${encodeURIComponent(item.id)}${trip}`);
    state.selection = {
      type: "route",
      route,
      dir: route.activeDirection || 0,
      operator: route.operator,
      back,
      here: opts.here || [],
      vehicle: opts.vehicle || null,
    };
    state.board = null;
    clearInterval(state.poll);
    paintRoute();
  } catch (error) {
    work.replaceChildren(el("p", { class: "empty" }, [error.message]));
  }
}

function paintRoute() {
  syncVehicleSelection();
  const sel = state.selection;
  const route = sel.route;
  const kind = LANES.routeKind(route.typeLabel, route.operator);
  setLineKind(kind);

  const view = el("div", { class: "route" });
  const head = el("div", { class: "head" }, [
    el("div", { class: "titles" }, [
      badge("span", "route-badge", kind, [route.short || route.typeLabel]),
      el("h2", { class: "wrap" }, [route.long && route.long !== route.short ? route.long : `Linea ${route.short || ""}`.trim()]),
      el("p", { class: "sub" }, [`${OP[route.operator] || route.operator} · ${route.typeLabel}`]),
    ]),
    backButton(sel.back),
  ]);
  view.append(head);
  if (sel.vehicle) {
    view.append(el("p", { class: "stamp-time" }, [`Mezzo ${sel.vehicle.id} · posizione GPS di ${sel.vehicle.ageSec} s fa`]));
  }

  const dirs = el("div", { class: "dirs", role: "group", "aria-label": "Direzione" });
  route.directions.forEach((direction, index) => {
    dirs.append(el("button", {
      type: "button",
      class: index === sel.dir ? "on" : "",
      onclick: () => {
        state.selection.dir = index;
        paintRoute();
      },
    }, [`Verso ${direction.headsign || "capolinea"}`]));
  });
  view.append(dirs);

  const direction = route.directions[sel.dir] || route.directions[0];
  if (!direction) {
    view.append(el("p", { class: "empty" }, ["Nessuna fermata disponibile per questa linea."]));
  } else {
    const list = el("ol", { class: "diagram" });
    direction.stops.forEach((stop, index) => {
      const ends = index === 0 || index === direction.stops.length - 1;
      const cap = index === 0 ? "partenza" : index === direction.stops.length - 1 ? "capolinea" : "";
      const here = (sel.here || []).includes(stop.stop_id);
      list.append(el("li", { class: `${ends ? "ends" : ""}${here ? " on" : ""}`.trim() }, [
        el("button", {
          type: "button",
          onclick: () => openStop({
            feed: route.feed,
            ids: [stop.stop_id],
            name: stop.name,
            operator: route.operator,
            lane: kind,
            lat: stop.lat,
            lon: stop.lon,
          }),
        }, [stop.name, cap ? el("span", { class: "cap" }, [cap]) : ""]),
      ]));
    });
    view.append(list);
  }

  work.replaceChildren(view);
  const current = view.querySelector(".diagram li.on");
  if (current) work.scrollTop += current.getBoundingClientRect().top - work.getBoundingClientRect().top - work.clientHeight / 3;
  drawRoute(route, sel.dir, kind, sel.here || []);
  applyMapMode();
}

const PATH_MARKS = {
  dash: { weight: 1.8, dashArray: "7 6", lineCap: "butt" },
  dot: { weight: 2.2, dashArray: "0.1 5.5", lineCap: "round" },
  ties: { weight: 6, dashArray: "1.8 7", lineCap: "butt" },
  long: { weight: 6, dashArray: "12 8", lineCap: "butt", onCasing: true },
};

function drawRoute(route, dir, kind, here = [], fit = true) {
  if (!state.routeLayer) return;
  state.routeLayer.clearLayers();
  const direction = route.directions[dir] || route.directions[0];
  if (!direction || !direction.stops.length) return;
  const stopPoints = direction.stops.map((stop) => [stop.lat, stop.lon]);
  const path = direction.shape && direction.shape.length > 1 ? direction.shape : stopPoints;
  const style = LANES.lineStyle(kind);
  const base = { lineJoin: "round", lineCap: "round", opacity: 1, interactive: false };
  L.polyline(path, { ...base, color: style.casing, weight: 10 }).addTo(state.routeLayer);
  L.polyline(path, { ...base, color: style.core, weight: 6 }).addTo(state.routeLayer);
  const mark = PATH_MARKS[style.pattern];
  if (mark) {
    L.polyline(path, { ...base, color: mark.onCasing ? style.casing : style.mark, weight: mark.weight, dashArray: mark.dashArray, lineCap: mark.lineCap }).addTo(state.routeLayer);
  }
  const white = LANES.css("--lane-white");
  const open = (stop) => openStop({ feed: route.feed, ids: [stop.stop_id], name: stop.name, operator: route.operator, lane: kind, lat: stop.lat, lon: stop.lon });
  direction.stops.forEach((stop, index) => {
    const isHere = here.includes(stop.stop_id);
    const isEnd = index === 0 || index === direction.stops.length - 1;
    if (isHere) {
      const covered = state.focusMarker && state.map.hasLayer(state.focusMarker) && distanceMeters(state.focusMarker.getLatLng().lat, state.focusMarker.getLatLng().lng, stop.lat, stop.lon) < 8;
      if (covered) return;
      L.marker([stop.lat, stop.lon], { icon: LANES.stopIcon(kind, "selected", badgeLines(kind, stop.lat, stop.lon)), pane: "stops", zIndexOffset: 1000, keyboard: false })
        .bindTooltip(escapeHtml(stop.name), { direction: "top", offset: [0, -14] })
        .on("click", () => open(stop))
        .addTo(state.routeLayer);
      return;
    }
    L.circleMarker([stop.lat, stop.lon], {
      radius: isEnd ? 6 : 4.2,
      color: isEnd ? style.casing : style.core,
      weight: 2.4,
      fillColor: isEnd ? style.core : white,
      fillOpacity: 1,
    })
      .bindTooltip(escapeHtml(stop.name))
      .on("click", () => open(stop))
      .addTo(state.routeLayer);
  });
  if (fit) fitView(L.latLngBounds(path), 16);
}

export { openRoute, paintRoute, drawRoute };
