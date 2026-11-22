/**
 * Pure decision math for game-style zoom LOD on canvas card media (zero DOM/store imports so it
 * can be unit-tested directly under Node `--experimental-strip-types`).
 */

export const LOD_BUCKETS = [128, 256, 512, 960, 1600] as const;

const RASTER_PATH = /\.(?:jpe?g|png|webp)$/i;
const TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function isPhoneViewport(viewW: number, viewH: number, coarse: boolean): boolean {
  return coarse || (viewW > 0 && viewH > 0 && Math.min(viewW, viewH) <= 500);
}

/** Whether a raw image URL can be served as a downscaled WebP thumbnail via `/__lalala/img`. */
export function canProxyLod(rawSrc: string, origin: string, proxyEnabled: boolean): boolean {
  if (!proxyEnabled) return false;
  const trimmed = rawSrc.trim();
  if (trimmed === "" || /^(?:data:|blob:)/i.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (
    parsed.pathname === "/__lalala/img" ||
    parsed.pathname.startsWith("/__lalala/") ||
    parsed.pathname.startsWith("/x/")
  ) {
    return false;
  }
  return RASTER_PATH.test(parsed.pathname);
}

/** Builds the `/__lalala/img` URL for `rawSrc` at `bucket` px, forwarding cache-bust params. */
export function lodUrlFor(rawSrc: string, bucket: number, origin: string): string {
  const parsed = new URL(rawSrc, origin);
  const params = new URLSearchParams();
  params.set("src", parsed.pathname);
  params.set("w", String(bucket));
  const v = parsed.searchParams.get("v") ?? parsed.searchParams.get("t");
  if (v !== null && v !== "") params.set("v", v);
  return `/__lalala/img?${params.toString()}`;
}

/**
 * Picks the target LOD pixel width (`128..1600`, or `Infinity` for full original resolution)
 * for an image occupying `(screenCssW, screenCssH)` CSS px on screen at camera `zoom`.
 *
 * Rules:
 * - Only downscale aggressively when genuinely tiny / zoomed out in overview mode.
 * - Readable cards on screen get full device sharpness (on desktop, full original resolution at
 *   `z >= 0.65` or whenever physical width > 1200 px; on phones, 2×–2.5× effective DPR capped at
 *   960/1600 px inline so diagrams stay crisp without ever decoding a 97 MB 4096px bitmap inline).
 */
export function chooseLodBucket(params: {
  readonly screenCssW: number;
  readonly screenCssH: number;
  readonly zoom: number;
  readonly dpr: number;
  readonly phone: boolean;
  readonly inModal: boolean;
  readonly forceFull: boolean;
}): number {
  if (params.inModal || params.forceFull) return Infinity;
  const { screenCssW, screenCssH, zoom, dpr, phone } = params;

  if (!phone) {
    // Desktop stays 100% lossless full resolution whenever the user is zoomed in to read a card.
    if (zoom >= 0.65) return Infinity;
    const effDpr = zoom < 0.3 ? 1.5 : Math.min(Math.max(dpr, 1), 2.0);
    const needed = Math.max(screenCssW, screenCssH * 0.75) * effDpr * 1.15;
    if (needed > 1280) return Infinity;
    for (const bucket of LOD_BUCKETS) {
      if (needed <= bucket) return bucket;
    }
    return Infinity;
  }

  // Phone: lean in overview (z < 0.3), crisp for readable cards (z >= 0.3), capped inline against Jetsam.
  const effDpr = zoom < 0.3 ? 1.25 : zoom < 0.55 ? 2.0 : Math.min(Math.max(dpr, 2.0), 2.5);
  const needed = Math.max(screenCssW, screenCssH * 0.75) * effDpr;
  const cap = zoom >= 1.15 ? 1600 : 960;
  const clamped = Math.min(needed, cap);
  for (const bucket of LOD_BUCKETS) {
    if (clamped <= bucket) return bucket;
  }
  return cap;
}

/**
 * Whether zooming out should step down an already-decoded image to reclaim memory.
 * Any settled step down reclaims oversized bitmaps (so zoom-in -> zoom-out returns to baseline
 * instead of pinning high-res bitmaps in memory).
 */
export function shouldDowngrade(currentBucket: number, targetBucket: number, _phone: boolean): boolean {
  return targetBucket < currentBucket;
}

/**
 * Tiny aspect-preserving transparent SVG placeholder (max 16 px -> <= 1 KB RGBA) so an unloaded
 * `<img>` frees its decoded bitmap without collapsing its box height or shifting card layout.
 */
export function placeholderDataUrl(w: number, h: number): string {
  if (!(w > 0 && h > 0)) return TINY_GIF;
  const max = Math.max(w, h);
  const pw = Math.max(1, Math.round((w / max) * 16));
  const ph = Math.max(1, Math.round((h / max) * 16));
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='${pw}' height='${ph}'/>`;
}
