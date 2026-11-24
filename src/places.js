/** FS Linea 2, west to east, as published in the ANM/Trenitalia GTFS. */
export const FS_STATIONS = [
  { code: "S09101", name: "Pozzuoli Solfatara", short: "Pozzuoli", gtfs: "POZZUOLI", lat: 40.82815, lon: 14.12569 },
  { code: "S09102", name: "Bagnoli Agnano Terme", short: "Bagnoli", gtfs: "BAGNOLI", lat: 40.81986, lon: 14.16683 },
  { code: "S09113", name: "Cavalleggeri Aosta", short: "Cavalleggeri", gtfs: "CAVALLEGGERI", lat: 40.81977, lon: 14.18658 },
  { code: "S09103", name: "Napoli Campi Flegrei", short: "Campi Flegrei", gtfs: "CAMPI FLEGREI", lat: 40.82253, lon: 14.19461 },
  { code: "S09104", name: "Napoli Piazza Leopardi", short: "Leopardi", gtfs: "LEOPARDI", lat: 40.82432, lon: 14.20004 },
  { code: "S09105", name: "Napoli Mergellina", short: "Mergellina", gtfs: "MERGELLINA", lat: 40.83145, lon: 14.21874 },
  { code: "S09106", name: "Napoli Piazza Amedeo", short: "Amedeo", gtfs: "AMEDEO", lat: 40.83885, lon: 14.23192 },
  { code: "S09107", name: "Napoli Montesanto", short: "Montesanto", gtfs: "MONTESANTO", lat: 40.84771, lon: 14.24416 },
  { code: "S09108", name: "Napoli Piazza Cavour", short: "Cavour", gtfs: "CAVOUR", lat: 40.85553, lon: 14.25471 },
  { code: "S09109", name: "Napoli Piazza Garibaldi", short: "Garibaldi", gtfs: "GARIBALDI", lat: 40.85265, lon: 14.27251 },
  { code: "S09110", name: "Napoli Gianturco", short: "Gianturco", gtfs: "GIANTURCO", lat: 40.85391, lon: 14.28735 },
  { code: "S09800", name: "Napoli San Giovanni Barra", short: "S. Giovanni", gtfs: "GIOVANNI", lat: 40.83224, lon: 14.30745 },
];

const FS_BY_CODE = new Map(FS_STATIONS.map((station) => [station.code, station]));

export function fsStation(code) {
  return FS_BY_CODE.get(code) || null;
}

const GENERIC_WORDS = /\b(bus|filobus|fermata|stazione|linea|metro|stop)\b/gi;

/** Drop mode words such as "bus" that would otherwise block matches on the place name. */
export function cleanQuery(value) {
  return String(value || "").replace(GENERIC_WORDS, " ").replace(/\s+/g, " ").trim();
}

export function nameKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const L2_KEYS = [
  "POZZUOLISOLFATARA",
  "POZZUOLI",
  "BAGNOLIAGNANOTERME",
  "CAVALLEGGERIAOSTA",
  "NAPOLICAMPIFLEGREI",
  "CAMPIFLEGREI",
  "NAPOLIPIAZZALEOPARDI",
  "NAPOLILEOPARDI",
  "NAPOLIMERGELLINA",
  "NAPOLIPIAZZAAMEDEO",
  "NAPOLIAMEDEO",
  "NAPOLIMONTESANTO",
  "NAPOLIPIAZZACAVOUR",
  "NAPOLICAVOUR",
  "NAPOLIPIAZZAGARIBALDI",
  "NAPOLIGARIBALDI",
  "NAPOLIGIANTURCO",
  "NAPOLISGIOVANNIBARRA",
  "NAPOLISANGIOVANNIBARRA",
];

/** True when a ViaggiaTreno origin or destination stays on Linea 2. */
export function isLinea2Place(value) {
  const key = nameKey(value);
  if (!key) return false;
  if (key.includes("SALERNO") || key.includes("CASERTA") || key.includes("CAPUA") || key.includes("ROMA") || key.includes("FORMIA") || key.includes("CASTELLAMMARE") || key.includes("BENEVENTO") || key.includes("AVERSA") || key.includes("VILLALITERNO") || key.includes("CANCELLO") || key.includes("CENTRALE")) {
    return false;
  }
  return L2_KEYS.some((place) => key === place || (key.length >= 8 && (key.includes(place) || place.includes(key))));
}

export function fsCodeForGtfsStop(stopName) {
  const key = nameKey(stopName);
  const found = FS_STATIONS.find((station) => key.includes(nameKey(station.gtfs)));
  return found ? found.code : null;
}

export function clockFromSeconds(total) {
  const normalized = ((total % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const ROME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function romeNow(date = new Date()) {
  const parts = Object.fromEntries(ROME_FMT.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    seconds: Number(hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    label: `${hour}:${parts.minute}`,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function previousYmd(ymd) {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

const VIAGGIA_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Rome",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function viaggiaStamp(date = new Date()) {
  const parts = Object.fromEntries(VIAGGIA_FMT.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.weekday} ${parts.month} ${Number(parts.day)} ${parts.year} ${hour}:${parts.minute}:${parts.second}`;
}

export const TYPE_LABEL = {
  0: "Tram",
  1: "Metro",
  2: "Treno",
  3: "Bus",
  7: "Funicolare",
  11: "Filobus",
};

export const OP_LABEL = {
  "eav-rail": "EAV treni",
  "eav-bus": "EAV bus",
  anm: "ANM",
  fs: "FS Linea 2",
};
