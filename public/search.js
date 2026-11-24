import { state } from "./state.js";
import { OP, $, query, results, statusEl, el, api } from "./util.js";
import { openFs, openEav, openStop } from "./board.js";
import { openRoute } from "./route.js";

function groupsFor(payload) {
  const stopItem = (stop) => ({ label: stop.name, lines: stop.lines || [], hint: OP[stop.operator] || stop.operator, run: () => openStop(stop) });
  return [
    {
      title: "FS Linea 2",
      items: [
        ...payload.stops.filter((stop) => stop.operator === "fs").map((stop) => ({ ...stopItem(stop), hint: "diretta ViaggiaTreno" })),
        ...payload.fs.map((station) => ({ label: station.name, lines: [], hint: "diretta ViaggiaTreno", run: () => openFs(station) })),
      ],
    },
    {
      title: "EAV treni",
      items: [
        ...payload.stops.filter((stop) => stop.operator === "eav-rail").map(stopItem),
        ...payload.eav.map((station) => ({ label: station.name, lines: [], hint: (station.lines || []).slice(0, 2).join(" · ") || "teleindicatore", run: () => openEav(station) })),
      ],
    },
    { title: "ANM", items: payload.stops.filter((stop) => stop.operator === "anm").map(stopItem) },
    { title: "EAV bus", items: payload.stops.filter((stop) => stop.operator === "eav-bus").map(stopItem) },
    {
      title: "Linee",
      items: payload.routes.map((route) => ({
        label: `${route.short || route.typeLabel} ${route.long}`.trim(),
        lines: [],
        hint: `${OP[route.operator]} · ${route.typeLabel}`,
        run: () => openRoute(route),
      })),
    },
  ].filter((group) => group.items.length);
}

function renderResults(payload) {
  state.lastPayload = payload;
  results.replaceChildren();
  const groups = groupsFor(payload);
  if (!groups.length) {
    results.append(el("p", { class: "empty", style: "padding:12px 14px;margin:0" }, [`Nessun risultato per «${query.value.trim()}».`]));
    results.hidden = false;
    return;
  }
  groups.forEach((group) => {
    const shown = group.items.slice(0, 8);
    const buttons = shown.map((item) => {
      const children = [el("span", { class: "name" }, [item.label])];
      if (item.lines && item.lines.length) {
        children.push(el("span", { class: "lines" }, item.lines.slice(0, 8).map((line) => el("span", { class: "ln" }, [line]))));
      }
      // The group header already names the operator; repeating it on every row blurs the grouping.
      if (item.hint && item.hint !== group.title) children.push(el("span", { class: "hint" }, [item.hint]));
      return el("button", { class: "result", type: "button", onclick: item.run }, children);
    });
    const count = group.items.length > shown.length ? `${shown.length} di ${group.items.length}` : String(shown.length);
    results.append(
      el("section", { class: "result-group" }, [
        el("h3", {}, [el("span", {}, [group.title]), el("span", { class: "count" }, [count])]),
        ...buttons,
      ]),
    );
  });
  results.hidden = false;
}

function firstResult() {
  const groups = state.lastPayload ? groupsFor(state.lastPayload) : [];
  for (const group of groups) {
    if (group.items.length) return group.items[0];
  }
  return null;
}

async function runSearch() {
  const value = query.value.trim();
  const generation = state.searchGeneration;
  if (value.length < 2) {
    results.hidden = true;
    return;
  }
  try {
    const payload = await api(`/api/suggest?q=${encodeURIComponent(value)}`);
    if (query.value.trim() !== value || generation !== state.searchGeneration) return;
    renderResults(payload);
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

query.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  if (query.value.trim().length < 2) {
    results.hidden = true;
    return;
  }
  state.searchTimer = setTimeout(runSearch, 160);
});

query.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(state.searchTimer);
  const go = () => {
    const first = firstResult();
    if (first) {
      results.hidden = true;
      first.run();
    }
  };
  if (state.lastPayload && query.value.trim().length >= 2 && !results.hidden) go();
  else runSearch().then(go);
});

$("#clear-query").addEventListener("click", (event) => {
  event.preventDefault(); // inside the <label>: don't let the click fall through to it
  clearTimeout(state.searchTimer);
  state.searchGeneration += 1; // drop any in-flight search
  query.value = "";
  results.hidden = true;
  query.focus();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".top, #sheet")) results.hidden = true;
});

export { renderResults };
