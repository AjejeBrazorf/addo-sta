import { state } from "./state.js";
import { THEME_KEY, HOME_COLLAPSED_KEY, $, work, setLineKind } from "./util.js";
import { fillStrip } from "./board.js";
import { drawRoute } from "./route.js";
import { applyFilter, syncBasemapTheme } from "./map.js";

const sheet = $("#sheet");
const grip = $("#grip");
const phoneQuery = window.matchMedia("(max-width: 860px)");

function setSnap(name) {
  sheet.style.maxHeight = "";
  sheet.dataset.snap = name;
  if (name !== "min") setCollapsed(false);
}

function isCollapsed() {
  return !phoneQuery.matches && sheet.hasAttribute("data-collapsed");
}

function syncGrip() {
  if (phoneQuery.matches) {
    grip.setAttribute("aria-label", "Alza o abbassa il pannello");
    grip.removeAttribute("aria-expanded");
    return;
  }
  const collapsed = sheet.hasAttribute("data-collapsed");
  grip.setAttribute("aria-label", collapsed ? "Espandi il pannello" : "Comprimi il pannello");
  grip.setAttribute("aria-expanded", String(!collapsed));
}

function setCollapsed(collapsed) {
  sheet.toggleAttribute("data-collapsed", collapsed);
  syncGrip();
}

function homeCollapsedPref() {
  try {
    return localStorage.getItem(HOME_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function sheetCover() {
  if (!phoneQuery.matches) return 0;
  const snap = sheet.dataset.snap;
  if (snap === "min") return 96;
  return Math.min(sheet.scrollHeight, window.innerHeight * 0.46);
}

function mapPadding() {
  if (phoneQuery.matches) {
    const top = document.querySelector(".top").getBoundingClientRect().bottom + 8;
    return { tl: [12, top], br: [12, sheetCover() + 12] };
  }
  if (isCollapsed()) return { tl: [24, sheet.getBoundingClientRect().bottom + 16], br: [88, 24] };
  const dock = document.querySelector(".dock").getBoundingClientRect();
  return { tl: [dock.right + 24, 24], br: [88, 24] };
}

function fitView(bounds, maxZoom) {
  if (!state.map) return;
  const pad = mapPadding();
  state.map.fitBounds(bounds, { paddingTopLeft: pad.tl, paddingBottomRight: pad.br, maxZoom, animate: true });
}

function syncChrome() {
  const root = document.documentElement.style;
  if (phoneQuery.matches) {
    const cover = Math.max(0, window.innerHeight - sheet.getBoundingClientRect().top);
    root.setProperty("--cover", `${Math.round(cover)}px`);
    root.setProperty("--chip-left", "0px");
    document.documentElement.toggleAttribute("data-sheet-high", window.innerHeight - cover < 172);
    return;
  }
  const rect = sheet.getBoundingClientRect();
  const dock = document.querySelector(".dock").getBoundingClientRect();
  const crowded = rect.bottom > window.innerHeight - 100; // .map-foot is ~70px tall
  document.documentElement.removeAttribute("data-sheet-high");
  root.setProperty("--cover", "0px");
  root.setProperty("--chip-left", crowded ? `${Math.round(dock.right)}px` : "0px");
}

function setupInfo() {
  const button = $("#info");
  const card = $("#info-card");
  const legend = $("#legend");
  const close = (focusButton = true) => {
    if (card.hidden) return;
    card.hidden = true;
    legend.replaceChildren();
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  button.addEventListener("click", () => {
    if (!card.hidden) {
      close();
      return;
    }
    legend.innerHTML = LANES.legendHtml();
    card.hidden = false;
    button.setAttribute("aria-expanded", "true");
    card.focus();
  });
  $("#info-close").addEventListener("click", () => close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!card.hidden && !event.target.closest("#info-card, #info")) close(false);
  });
}

function setupChrome() {
  syncChrome();
  if (window.ResizeObserver) new ResizeObserver(syncChrome).observe(sheet);
  window.addEventListener("resize", syncChrome);
  phoneQuery.addEventListener("change", syncChrome);
  setupInfo();
}

function setupSheet() {
  let startY = 0;
  let startHeight = 0;
  let moved = false;
  syncGrip();
  phoneQuery.addEventListener("change", syncGrip);
  grip.addEventListener("click", () => {
    if (phoneQuery.matches) return;
    const collapsed = !sheet.hasAttribute("data-collapsed");
    setCollapsed(collapsed);
    if (work.querySelector(".home")) {
      try {
        localStorage.setItem(HOME_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {}
    }
  });
  grip.addEventListener("pointerdown", (event) => {
    if (phoneQuery.matches === false) return;
    startY = event.clientY;
    startHeight = sheet.getBoundingClientRect().height;
    moved = false;
    grip.setPointerCapture(event.pointerId);
    sheet.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (event) => {
    if (!grip.hasPointerCapture(event.pointerId)) return;
    const dy = event.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const max = window.innerHeight - 128;
    sheet.style.maxHeight = `${Math.max(96, Math.min(max, startHeight - dy))}px`;
  });
  const release = (event) => {
    if (!grip.hasPointerCapture(event.pointerId)) return;
    grip.releasePointerCapture(event.pointerId);
    sheet.classList.remove("dragging");
    const current = sheet.getBoundingClientRect().height;
    const order = ["min", "peek", "full"];
    const current_snap = sheet.dataset.snap;
    if (!moved) {
      setSnap(current_snap === "peek" ? "full" : "peek");
      return;
    }
    const heights = { min: 96, peek: window.innerHeight * 0.46, full: window.innerHeight - 128 };
    const nearest = order.reduce((best, name) => (Math.abs(heights[name] - current) < Math.abs(heights[best] - current) ? name : best), "peek");
    setSnap(nearest);
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);
}

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  const meta = $("#theme-color");
  if (meta) meta.content = theme === "dark" ? "#1a1f29" : "#ffffff";
  syncBasemapTheme();
  const button = $("#theme");
  if (button) {
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.setAttribute("aria-label", theme === "dark" ? "Passa al tema chiaro" : "Passa al tema scuro");
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* the choice just will not be remembered */
    }
  }
}

function refreshThemeColors() {
  if (state.map) applyFilter();
  if (!state.selection) {
    setLineKind(null);
    return;
  }
  if (state.selection.type === "route") {
    const route = state.selection.route;
    drawRoute(route, state.selection.dir, LANES.routeKind(route.typeLabel, route.operator), state.selection.here || [], false);
    return;
  }
  fillStrip();
}

function setupTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  $("#theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next, true);
    refreshThemeColors();
  });
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", (event) => {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      stored = null;
    }
    if (stored) return;
    applyTheme(event.matches ? "dark" : "light");
    refreshThemeColors();
  });
}

export { setSnap, setCollapsed, homeCollapsedPref, fitView, setupChrome, setupSheet, setupTheme };
