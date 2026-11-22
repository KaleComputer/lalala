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
  const effDpr = phone
    ? zoom < 0.45
      ? 1.0
      : zoom < 0.85
        ? 1.5
        : 2.0
    : zoom < 0.35
      ? 1.25
      : zoom < 0.7
        ? Math.min(dpr, 1.75)
        : Math.min(dpr, 2.0);
  // Primarily width-driven, with a floor from height so tall portrait diagrams stay crisp.
  const needed = Math.max(screenCssW, screenCssH * 0.75) * effDpr;

  if (phone) {
    // Never decode a 4096px bitmap inline on a phone: full-res opens in ZoomImage modal.
    const cap = zoom >= 1.35 ? 1600 : 960;
    const clamped = Math.min(needed, cap);
    for (const bucket of LOD_BUCKETS) {
      if (clamped <= bucket) return bucket;
    }
    return cap;
  }

  // Desktop stays razor-sharp when zoomed in close or when the card image is huge on screen.
  if (needed > 1600 || (zoom >= 0.9 && needed > 1100)) return Infinity;
  for (const bucket of LOD_BUCKETS) {
    if (needed <= bucket) return bucket;
  }
  return Infinity;
}

/** Whether zooming out should step down an already-decoded image to reclaim memory. */
export function shouldDowngrade(currentBucket: number, targetBucket: number, phone: boolean): boolean {
  if (targetBucket >= currentBucket) return false;
  if (phone) {
    return currentBucket === Infinity || currentBucket >= targetBucket * 2;
  }
  if (currentBucket === Infinity) return targetBucket <= 512;
  return currentBucket > 512 && currentBucket >= targetBucket * 2;
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
