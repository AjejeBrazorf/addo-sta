const OP = {
  fs: "FS Linea 2",
  "eav-rail": "EAV treni",
  "eav-bus": "EAV bus",
  anm: "ANM",
};
const THEME_KEY = "banchina.theme";
const POLL_MS = 20000;
const REQUEST_MS = 9000;
const RECENT_KEY = "banchina.recent";
const HOME_COLLAPSED_KEY = "banchina.homeCollapsed";
const LAYERS_KEY = "banchina.layers";
const LAYER_DEFAULTS = { anm: true, "eav-rail": true, "eav-bus": true, fs: true, vehicles: true };

const $ = (selector) => document.querySelector(selector);
const query = $("#query");
const results = $("#results");
const work = $("#work");
const statusEl = $("#status");
const vehicleCount = $("#vcount");


const freshEl = document.querySelector("#fresh");
const freshText = document.querySelector("#fresh-text");

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value != null) node.setAttribute(key, value);
  });
  children.forEach((child) => node.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return node;
}

function romeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type).value);
  return { hour: pick("hour") % 24, minute: pick("minute") };
}

function minutesUntil(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const now = romeParts();
  let diff = h * 60 + m - (now.hour * 60 + now.minute);
  if (diff < -720) diff += 1440;
  return diff;
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
}

async function api(path, ms = REQUEST_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(path, { signal: controller.signal, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Dato non disponibile");
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Nessuna risposta in tempo utile");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function delayLabel(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return { text: String(value), className: "delay" };
  if (number > 0) return { text: `+${number} min`, className: "delay late" };
  if (number < 0) return { text: `${number} min`, className: "delay early" };
  return { text: "in orario", className: "delay ok" };
}

function when(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return "";
  if (minutes <= 0) return "ora";
  if (minutes === 1) return "tra 1 min";
  return `tra ${minutes} min`;
}

function setLineKind(kind) {
  if (kind) work.dataset.lane = kind;
  else delete work.dataset.lane;
}

function badge(tag, cls, kind, children) {
  return el(tag, { class: `${cls} kb`, "data-k": kind }, children);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function normalize(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function loose(value) {
  return normalize(value).replaceAll("PIAZZA", "P");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export { OP, POLL_MS, RECENT_KEY, $, query, results, work, statusEl, el, minutesUntil, clockTime, api, delayLabel, when, setLineKind, badge, distanceMeters, formatDistance, loose, escapeHtml, LAYERS_KEY, LAYER_DEFAULTS, vehicleCount, freshEl, freshText, THEME_KEY, HOME_COLLAPSED_KEY };
