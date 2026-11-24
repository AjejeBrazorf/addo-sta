import { state } from "./state.js";
import { statusEl, api } from "./util.js";
import { renderHome, locateMe } from "./board.js";
import { applyFilter, setupMap, loadPlaces, setupLayers } from "./map.js";
import { setupChrome, setupSheet, setupTheme } from "./ui.js";

async function boot() {
  setupTheme();
  setupSheet();
  setupChrome();
  setupLayers();
  setupMap();
  renderHome();
  const locate = document.querySelector("#locate");
  locate.addEventListener("click", () => locateMe(locate));
  // ponytail: "phone" = touch-first pointer; tablets count too, which is fine for a transit map.
  if (matchMedia("(pointer: coarse)").matches) locateMe(locate, true);
  try {
    const fs = await api("/api/fs/stations");
    state.fsStations = fs.stations;
    if (state.railLayer) applyFilter();
  } catch (error) {
    statusEl.textContent = error.message;
  }
  try {
    const eav = await api("/api/eav/stations");
    state.eavStations = eav.stations;
  } catch (error) {
    statusEl.textContent = error.message;
  }
  const wait = async () => {
    const info = await api("/api/status");
    if (info.rebuilding && !info.schedule) statusEl.textContent = "Scarico gli orari aperti di EAV e ANM…";
    if (info.error && !info.schedule) statusEl.textContent = info.error;
    if (info.schedule) {
      statusEl.textContent = "";
      await loadPlaces();
      return;
    }
    setTimeout(wait, 2000);
  };
  wait().catch((error) => {
    statusEl.textContent = error.message;
  });
}

boot();
