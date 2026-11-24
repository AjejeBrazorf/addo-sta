import { getBuffer, upstreamError } from "./net.js";
import { FS_STATIONS, fsStation, isLinea2Place, viaggiaStamp } from "./places.js";

const UA = "Mozilla/5.0 (compatible; AddoSta/1.0; +https://www.eavsrl.it/open-data/)";
// ViaggiaTreno's WAF answers 403 to a UA carrying a URL; this plain one works. Its HTTPS endpoint 301s back to http, so it stays http.
const VT_UA = "Mozilla/5.0 (compatible; AddoSta/1.0)";
const memory = new Map();

function remember(key, ttl, producer) {
  const hit = memory.get(key);
  if (hit && (hit.pending || hit.expires > Date.now())) return hit.value;
  const value = Promise.resolve()
    .then(producer)
    .then((result) => {
      memory.set(key, { value: Promise.resolve(result), pending: false, expires: Date.now() + ttl });
      return result;
    })
    .catch((error) => {
      memory.delete(key);
      throw error;
    });
  memory.set(key, { value, pending: true, expires: 0 });
  return value;
}

async function getText(url, options = {}) {
  const buffer = await getBuffer(url, {
    method: options.method,
    body: options.body,
    headers: { accept: "text/html,application/json,*/*", "user-agent": UA, ...(options.headers || {}) },
  });
  return buffer.toString("utf8");
}

function decode(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] || all;
  });
}

function text(fragment) {
  return decode(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function eavStationsFromHtml(html) {
  const match = html.match(/<script id="data-localita"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw upstreamError("Elenco stazioni EAV non trovato");
  const raw = JSON.parse(match[1]);
  const byId = new Map();
  for (const item of raw) {
    if (String(item.visualizzato).toLowerCase() === "false") continue;
    const id = String(item.id || "");
    if (!/^\d{1,6}$/.test(id)) continue;
    const current = byId.get(id) || {
      id,
      name: text(String(item.descrizione || "")),
      lines: [],
      touchpoint: "",
    };
    if (item.linea && !current.lines.includes(item.linea)) current.lines.push(item.linea);
    if (!current.touchpoint && typeof item.touchpoint === "string") current.touchpoint = item.touchpoint;
    byId.set(id, current);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
}

export function eavBoardFromHtml(html) {
  const name = text((html.match(/class="nomeLocalita"[\s\S]*?<strong>([\s\S]*?)<\/strong>/) || [])[1] || "");
  const rows = [];
  for (const chunk of html.matchAll(/<tr class="testoGiallo"[\s\S]*?<\/tr>/g)) {
    const row = chunk[0];
    const cell = (className) => text((row.match(new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)</`)) || [])[1] || "");
    const train = cell("numTreno");
    const time = cell("orario");
    if (!train && !time) continue;
    rows.push({
      train,
      category: cell("categoria"),
      destination: cell("destinazione"),
      info: cell("informazioni"),
      platform: cell("binario"),
      time,
      delay: cell("ritardo"),
    });
  }
  return { name, rows };
}

export function eavStations() {
  return remember("eav-stations", 60 * 60 * 1000, async () => {
    const html = await getText("https://orariotreni.eavsrl.it/");
    return eavStationsFromHtml(html);
  });
}

export function eavBoard(id, kind) {
  if (!/^\d{1,6}$/.test(id)) throw new Error("Stazione EAV non valida");
  if (kind !== "P" && kind !== "A") throw new Error("Tipo banchina non valido");
  return remember(`eav-board:${id}:${kind}`, 12000, async () => {
    const stations = await eavStations();
    const station = stations.find((item) => item.id === id);
    if (!station) throw new Error("Stazione EAV non in elenco");
    const body = new URLSearchParams({
      device: "M01T1M",
      tipoLista: kind,
      codLoc: id,
      touchpoint: station.touchpoint || "",
      visualizzazione: "mobile",
    });
    const html = await getText("https://orariotreni.eavsrl.it/teleindicatori/ws_getData_pis.php", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: "https://orariotreni.eavsrl.it/teleindicatori/",
      },
      body,
    });
    const board = eavBoardFromHtml(html);
    return {
      system: "eav",
      live: true,
      id,
      name: board.name || station.name,
      lines: station.lines,
      kind,
      updatedAt: new Date().toISOString(),
      rows: board.rows,
    };
  });
}

function trainRow(train, kind) {
  const place = kind === "arrivi" ? train.origine || train.origineZero : train.destinazione || train.destinazioneZero;
  if (!isLinea2Place(place)) return null;
  const scheduled = kind === "arrivi"
    ? train.compOrarioArrivo || train.compOrarioArrivoZero
    : train.compOrarioPartenzaZero || train.compOrarioPartenza;
  const platform = kind === "arrivi"
    ? train.binarioEffettivoArrivoDescrizione || train.binarioProgrammatoArrivoDescrizione
    : train.binarioEffettivoPartenzaDescrizione || train.binarioProgrammatoPartenzaDescrizione;
  const delay = Number.isFinite(train.ritardo) ? train.ritardo : null;
  return {
    train: train.numeroTreno,
    category: train.categoria || "MET",
    place,
    time: scheduled || "",
    delay,
    platform: platform || "",
    departed: Boolean(train.arrivato),
  };
}

export function fsBoard(code, kind) {
  const station = fsStation(code);
  if (!station) throw new Error("Stazione FS fuori dalla Linea 2");
  if (kind !== "partenze" && kind !== "arrivi") throw new Error("Tipo banchina non valido");
  return remember(`fs-board:${code}:${kind}`, 15000, async () => {
    const stamp = encodeURIComponent(viaggiaStamp());
    const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/${kind}/${code}/${stamp}`;
    const payload = await getText(url, {
      headers: { accept: "application/json", "user-agent": VT_UA },
    });
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw upstreamError("ViaggiaTreno non ha restituito la banchina");
    }
    const rows = (Array.isArray(parsed) ? parsed : []).map((train) => trainRow(train, kind)).filter(Boolean).filter((row) => !row.departed);
    return {
      system: "fs",
      live: true,
      code,
      name: station.name,
      kind,
      updatedAt: new Date().toISOString(),
      rows,
      note: "Solo i treni della Linea 2, da Pozzuoli a San Giovanni a Barra. I regionali che proseguono fuori città restano fuori.",
    };
  });
}

export function fsStations() {
  return FS_STATIONS;
}
