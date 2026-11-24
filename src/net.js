import http from "node:http";
import https from "node:https";

const UA = "Mozilla/5.0 (compatible; BanchinaNapoli/1.0)";
const MAX_BYTES = 25 * 1024 * 1024;

/** Upstream failure: 502 for the client, message safe to show (Italian, no internals). */
export function upstreamError(message, cause) {
  return Object.assign(new Error(message, { cause }), { status: 502, expose: true });
}

/** IPv4 only: some upstream hosts resolve to unreachable IPv6 addresses from this network. */
export function getBuffer(url, { method = "GET", headers = {}, body } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(
      url,
      {
        method,
        family: 4,
        headers: { "user-agent": UA, accept: "*/*", ...headers },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          if (url.startsWith("https:") && !next.startsWith("https:")) {
            reject(upstreamError("Sorgente non sicura (redirect a http)"));
            return;
          }
          resolve(getBuffer(next, { method, headers, body }, redirects + 1));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(upstreamError("Risposta della sorgente troppo grande"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 400) reject(upstreamError(`Sorgente non disponibile (${res.statusCode})`));
          else resolve(buffer);
        });
        res.on("error", (error) => reject(error.expose ? error : upstreamError("Sorgente non raggiungibile", error)));
      },
    );
    req.setTimeout(15000, () => req.destroy(upstreamError("Sorgente in timeout")));
    req.on("error", (error) => reject(error.expose ? error : upstreamError("Sorgente non raggiungibile", error)));
    if (body) req.write(String(body));
    req.end();
  });
}
