// What T3 Code hands out for pairing, read the same way by the app's bridge and lalala.talk's tab.

const DEFAULT_ORIGIN = "http://127.0.0.1:3773";

/**
 * Reads what T3 hands out: the bare code (Copy code), a pairing link (`http://127.0.0.1:3773/pair#token=…`),
 * its hosted form (`…/pair?host=…#token=…`), a `t3code://pair?pairingUrl=…` link, or the desktop's own
 * `t3code://app/pair#token=…`, which names no server: codes and those go to T3's default address.
 */
export function readPairing(input: string): { origin: string; token: string } {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(value)) return { origin: DEFAULT_ORIGIN, token: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is neither a pairing code nor a link. Copy it again from T3 Code.");
  }
  const appLink = url.searchParams.get("pairingUrl");
  if (appLink) return readPairing(appLink);
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new Error("That link has no pairing code in it. Copy it again from T3 Code.");
  const host = serverOrigin(url.searchParams.get("host"));
  const own = url.protocol === "http:" || url.protocol === "https:" ? reachable(url) : null;
  return { origin: host ?? own ?? DEFAULT_ORIGIN, token };
}

/** A server bound to every interface (T3 then links `0.0.0.0`) answers on loopback. */
function reachable(url: URL): string {
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  return url.origin;
}

/** The http(s) origin in `value` (a scheme-less `host:port` counts as http), or null when it names none. */
function serverOrigin(value: string | null): string | null {
  if (!value) return null;
  for (const candidate of [value, `http://${value}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return reachable(url);
    } catch {}
  }
  return null;
}

/** The pairing as one http(s) link, the form the app's bridge takes. */
export function pairingLink(input: string) {
  const { origin, token } = readPairing(input);
  return `${origin}/pair#token=${encodeURIComponent(token)}`;
}
