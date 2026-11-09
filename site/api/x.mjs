// Brain cards' outside pictures, media, scripts and stylesheets, re-served from lalala.talk.
// The page is cross-origin isolated (COEP require-corp, for multi-threaded speech): a card can only
// load another site's file when that site sends Cross-Origin-Resource-Policy, and most don't.
// /x/<host>/<path>?<query> fetches https://<host>/<path>?<query> and returns it with that header.
// No cookies either way, GET only, public hosts only, a short list of file types, size-capped.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TYPES = /^(image\/[\w.+-]+|audio\/[\w.+-]+|video\/[\w.+-]+|font\/[\w.+-]+|application\/(x-)?font-[\w.+-]+|text\/css|(text|application)\/(x-)?javascript)$/;
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

// Best effort per instance; Vercel's CDN cache answers repeats without reaching the function.
const RATE = { windowMs: 60_000, max: 240 };
const hits = new Map();

/** @param {string} ip */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v6 === "::" || v6 === "::1" || /^(fc|fd|fe[89ab])/.test(v6) || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** The remote URL a /x/ path names, or null when it isn't a plain public https address. */
export function remoteUrl(pathname, search) {
  const match = /^\/x\/([^/?#]+)(\/[^?#]*)?$/.exec(pathname);
  if (!match) return null;
  let url;
  try {
    url = new URL(`https://${match[1]}${match[2] ?? "/"}${search}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.port || url.username || url.password) return null;
  if (!host.includes(".") || /\.(local|internal|localhost|home|lan|corp)$/i.test(host)) return null;
  if (isIP(host) && isPrivateAddress(host)) return null;
  return url;
}

/** The type to serve, or null when it isn't one a card's markup loads. */
export function servedType(contentType, pathname) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (TYPES.test(type)) return type;
  if ((type === "application/octet-stream" || type === "") && FONT_FILE.test(pathname)) return "font/" + pathname.split(".").pop().toLowerCase();
  return null;
}

/** A proxied stylesheet's url(…) and @import addresses, pointed back through /x/ so they load too. */
export function rewriteCss(css, base) {
  const through = (raw) => {
    if (/^(data|blob):/i.test(raw) || raw.startsWith("#")) return raw;
    try {
      const url = new URL(raw, base);
      return url.protocol === "https:" ? `/x/${url.host}${url.pathname}${url.search}` : raw;
    } catch {
      return raw;
    }
  };
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (_, q, raw) => `url(${q}${through(raw)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, raw) => `@import ${q}${through(raw)}${q}`);
}

async function publicHost(hostname) {
  if (isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

function limited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE.windowMs) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE.max;
}

const fail = (status, message) =>
  new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": status === 429 ? "no-store" : "public, max-age=60",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    },
  });

async function readCapped(body) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** @param {Request} request */
export async function GET(request) {
  const self = new URL(request.url);
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (ip && limited(ip)) return fail(429, "too many requests");

  // Only pages on this site (their cards send its address as the referrer).
  const referrer = request.headers.get("referer");
  if (referrer) {
    try {
      if (new URL(referrer).host !== self.host) return fail(403, "not from this site");
    } catch {
      return fail(403, "not from this site");
    }
  }

  // vercel.json rewrites /x/<rest> here and also passes <rest> as __x, in case the URL arrives rewritten.
  const rest = self.searchParams.get("__x");
  self.searchParams.delete("__x");
  const pathname = self.pathname.startsWith("/x/") || rest === null ? self.pathname : `/x/${rest}`;
  let url = remoteUrl(pathname, self.search);
  if (!url) return fail(400, "not a public https address");

  let response;
  for (let hop = 0; ; hop++) {
    if (!(await publicHost(url.hostname))) return fail(403, "not a public host");
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { accept: request.headers.get("accept") ?? "*/*", "user-agent": "lalala.talk card proxy" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return fail(502, "could not reach it");
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    if (hop === MAX_REDIRECTS) return fail(508, "too many redirects");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.port || !remoteUrl(`/x/${next.host}${next.pathname}`, next.search)) return fail(403, "redirect to a non-public address");
    url = next;
  }
  if (!response.ok) return fail(response.status === 404 ? 404 : 502, `upstream ${response.status}`);

  const type = servedType(response.headers.get("content-type"), url.pathname);
  if (!type) return fail(415, "not a picture, font, sound, video, script or stylesheet");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) return fail(413, "too large");
  const body = response.body ? await readCapped(response.body) : Buffer.alloc(0);
  if (!body) return fail(413, "too large");

  return new Response(type === "text/css" ? rewriteCss(body.toString("utf8"), url) : body, {
    headers: {
      "content-type": type === "text/css" || type.endsWith("javascript") ? `${type}; charset=utf-8` : type,
      "cache-control": "public, max-age=86400, s-maxage=604800",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      // An SVG or anything else opened directly runs in an opaque origin, never as lalala.talk.
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export { GET as HEAD };
