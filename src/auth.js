import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** On Fly or with NODE_ENV=production the shared password and the cookie secret are mandatory. */
export function missingSecrets(env) {
  if (!env.FLY_APP_NAME && env.NODE_ENV !== "production") return [];
  return ["ACCESS_PASSWORD", "SESSION_SECRET"].filter((name) => !env[name]);
}

/** Cookie value. Keyed by a server secret, so a leaked cookie can't be brute-forced offline; rotating either value logs everyone out. */
export function sessionToken(secret, password) {
  return createHmac("sha256", secret).update(`banchina:v1:${password}`).digest("hex");
}

export function sameText(a, b) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export function cookieValid(cookieHeader, token) {
  const match = (cookieHeader || "").match(/(?:^|;\s*)banchina=([a-f0-9]+)/);
  return Boolean(match && sameText(match[1], token));
}

/** Failed logins per IP in a fixed window from the first failure. The map is capped: expired entries go first, then the oldest. */
export function failureLimiter({ max = 10, windowMs = 15 * 60 * 1000, maxKeys = 10000 } = {}) {
  const hits = new Map();
  const live = (ip, now) => {
    const entry = hits.get(ip);
    if (entry && now - entry.since < windowMs) return entry;
    hits.delete(ip);
    return null;
  };
  return {
    blocked: (ip, now = Date.now()) => (live(ip, now)?.count || 0) >= max,
    fail(ip, now = Date.now()) {
      const entry = live(ip, now);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (hits.size >= maxKeys) {
        for (const [key, value] of hits) if (now - value.since >= windowMs) hits.delete(key);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      }
      hits.set(ip, { count: 1, since: now });
    },
    reset: (ip) => hits.delete(ip),
    get size() {
      return hits.size;
    },
  };
}
