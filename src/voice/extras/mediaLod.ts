import { getCamera, getView, subscribe } from "./canvasStore";
import {
  canProxyLod,
  chooseLodBucket,
  isPhoneViewport,
  lodUrlFor,
  placeholderDataUrl,
  shouldDowngrade,
} from "./mediaLodMath";

export {
  LOD_BUCKETS,
  canProxyLod,
  chooseLodBucket,
  isPhoneViewport,
  lodUrlFor,
  placeholderDataUrl,
  shouldDowngrade,
} from "./mediaLodMath";

/**
 * Game-style zoom LOD + viewport media culling for canvas cards.
 *
 * Strategy (like game mipmaps + frustum culling):
 * 1. Off-screen cards (`data-lalala-card-off`) or images scrolled/panned outside the viewport margin
 *    actively release their decoded bitmaps (swapped to a tiny <= 16 px aspect-preserving SVG
 *    placeholder so layout height never collapses or churns `fitCard`).
 * 2. Visible images request downscaled WebP thumbnails via `/__lalala/img?src=...&w=<bucket>` sized
 *    to their actual rendered screen width and zoom level (`128 / 256 / 512 / 960 / 1600` px).
 * 3. Zooming in smoothly preloads sharper buckets off-DOM before swapping (zero flash); zooming back
 *    out downgrades oversized bitmaps to reclaim RAM; opening an image in a modal `<dialog>`
 *    (`ZoomImage`) or marking `[data-lalala-lod="full"]` always gets untouched full resolution.
 * 4. Off-screen paused `<video>` elements release their decoded frames and restore `src` on return.
 */

const UPGRADE_SETTLE_MS = 140;
const DOWNGRADE_SETTLE_MS = 300;
const SCROLL_DEBOUNCE_MS = 90;
const SHARPEN_DEBOUNCE_MS = 80;

type ImgRecord = {
  originalSrc: string;
  originalSrcset: string | null;
  appliedSrc: string;
  bucket: number; // 0 = culled, 128..1600 = thumb, Infinity = full
  natW: number;
  natH: number;
  savedWidth: string | null;
  savedHeight: string | null;
  preload: HTMLImageElement | null;
  preloadBucket: number;
};

type VideoRecord = {
  originalSrc: string;
  originalPreload: string | null;
  unloaded: boolean;
};

const isUnmanagedImg = (img: HTMLImageElement) =>
  img.hasAttribute("data-lalala-zoom-img") ||
  img.hasAttribute("data-lalala-lod-full") ||
  img.closest("dialog") !== null;

const isDynamicSrc = (src: string) => src === "" || /^(?:data:|blob:)/i.test(src.trim());

/**
 * Attaches game-style zoom LOD and off-screen media unloading to the canvas world container.
 * Safe on both the local app (WebP LOD + culling) and lalala.talk static site (culling only).
 */
export function attachMediaLod(world: HTMLElement): () => void {
  const proxyEnabled = import.meta.env.LALALA_HOST !== "site";
  const records = new WeakMap<HTMLImageElement, ImgRecord>();
  const videos = new WeakMap<HTMLVideoElement, VideoRecord>();
  const failedProxy = new Set<string>();
  const activePreloads = new Set<HTMLImageElement>();

  let raf = 0;
  let upgradeTimer = 0;
  let downgradeTimer = 0;
  let scrollTimer = 0;
  let sharpenTimer = 0;
  let sharpenFrame = 0;
  let lastZoom = getCamera().z;
  let lastZoomChangeAt = 0;

  /**
   * Forces composited card layers to re-rasterize sharp after an async LOD upgrade lands
   * (otherwise WebKit/Blink can keep a layer rasterized at the earlier blurry zoom scale).
   */
  const pulseSharpen = () => {
    window.clearTimeout(sharpenTimer);
    sharpenTimer = window.setTimeout(() => {
      sharpenTimer = 0;
      window.cancelAnimationFrame(sharpenFrame);
      world.dataset.lalalaSharpen = "";
      sharpenFrame = window.requestAnimationFrame(() => {
        sharpenFrame = window.requestAnimationFrame(() => {
          sharpenFrame = 0;
          delete world.dataset.lalalaSharpen;
        });
      });
    }, SHARPEN_DEBOUNCE_MS);
  };

  const releasePreload = (pre: HTMLImageElement) => {
    pre.onload = null;
    pre.onerror = null;
    pre.src = "";
    activePreloads.delete(pre);
  };

  const cancelPreload = (rec: ImgRecord) => {
    if (rec.preload !== null) {
      releasePreload(rec.preload);
      rec.preload = null;
      rec.preloadBucket = 0;
    }
  };

  /** Syncs our WeakMap record if React or card code updated `img`'s `src` attribute directly. */
  const syncRecord = (img: HTMLImageElement): ImgRecord | null => {
    if (isUnmanagedImg(img)) return null;
    const attr = img.getAttribute("src") ?? "";
    let rec = records.get(img);
    if (rec === undefined) {
      if (isDynamicSrc(attr)) return null;
      rec = {
        originalSrc: attr,
        originalSrcset: img.getAttribute("srcset"),
        appliedSrc: attr,
        bucket: Infinity,
        natW: img.complete && img.naturalWidth > 16 ? img.naturalWidth : 0,
        natH: img.complete && img.naturalHeight > 16 ? img.naturalHeight : 0,
        savedWidth: null,
        savedHeight: null,
        preload: null,
        preloadBucket: 0,
      };
      records.set(img, rec);
      return rec;
    }
    if (attr !== rec.appliedSrc) {
      // React / card script changed `src` (e.g. next slide or refreshed snapshot).
      cancelPreload(rec);
      if (isDynamicSrc(attr)) {
        records.delete(img);
        return null;
      }
      rec.originalSrc = attr;
      rec.originalSrcset = img.getAttribute("srcset");
      rec.appliedSrc = attr;
      rec.bucket = Infinity;
      rec.natW = 0;
      rec.natH = 0;
    } else if (rec.bucket > 0 && img.complete && img.naturalWidth > 16 && img.naturalHeight > 16) {
      rec.natW = img.naturalWidth;
      rec.natH = img.naturalHeight;
    }
    return rec;
  };

  const applySrc = (img: HTMLImageElement, rec: ImgRecord, nextSrc: string, bucket: number) => {
    if (rec.appliedSrc === nextSrc && rec.bucket === bucket) return;
    rec.appliedSrc = nextSrc;
    rec.bucket = bucket;
    if (bucket === Infinity) {
      if (rec.originalSrcset !== null) img.setAttribute("srcset", rec.originalSrcset);
    } else if (img.hasAttribute("srcset")) {
      img.removeAttribute("srcset");
    }
    // Actively managed visible images should decode immediately instead of stalling on loading="lazy".
    if (bucket > 0 && img.getAttribute("loading") === "lazy") {
      img.loading = "eager";
    }
    img.setAttribute("src", nextSrc);
    img.dataset.lalalaLod = bucket === 0 ? "culled" : bucket === Infinity ? "full" : String(bucket);
  };

  const urlForBucket = (originalSrc: string, bucket: number): string => {
    if (
      bucket === Infinity ||
      failedProxy.has(originalSrc) ||
      !canProxyLod(originalSrc, location.origin, proxyEnabled)
    ) {
      return originalSrc;
    }
    return lodUrlFor(originalSrc, bucket, location.origin);
  };

  const updateVideos = (phone: boolean) => {
    const list = world.getElementsByTagName("video");
    for (let i = 0; i < list.length; i += 1) {
      const video = list[i]!;
      if (video.closest("dialog")) continue;
      const card = video.closest<HTMLElement>("[data-lalala-card]");
      const off = card?.hasAttribute("data-lalala-card-off") ?? false;
      let rec = videos.get(video);
      if (off) {
        // Never interrupt a playing video; only release paused off-screen decoders.
        if (!video.paused && !video.ended) continue;
        const src = video.getAttribute("src");
        if (!rec && src && (phone || video.readyState > 0)) {
          rec = {
            originalSrc: src,
            originalPreload: video.getAttribute("preload"),
            unloaded: false,
          };
          videos.set(video, rec);
        }
        if (rec && !rec.unloaded) {
          rec.unloaded = true;
          video.removeAttribute("src");
          video.setAttribute("preload", "none");
          video.load();
        }
      } else if (rec?.unloaded) {
        rec.unloaded = false;
        video.setAttribute("src", rec.originalSrc);
        if (rec.originalPreload !== null) video.setAttribute("preload", rec.originalPreload);
        else video.removeAttribute("preload");
      }
    }
  };

  const evaluate = (allowUpgrade: boolean, allowDowngrade: boolean) => {
    const view = getView();
    const viewW = view.w || window.innerWidth;
    const viewH = view.h || window.innerHeight;
    if (viewW <= 0 || viewH <= 0) return;

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const phone = isPhoneViewport(viewW, viewH, coarse);
    const { z } = getCamera();
    const dpr = window.devicePixelRatio || 1;
    const marginX = phone ? 64 : Math.max(300, viewW * 0.35);
    const marginY = phone ? 80 : Math.max(300, viewH * 0.4);

    // Phase 1: Batch all DOM geometry reads before any writes to avoid layout thrashing.
    const bodyRects = new Map<HTMLElement, DOMRect>();
    const cardRects = new Map<HTMLElement, DOMRect>();
    const imgs = world.getElementsByTagName("img");
    const plan: Array<{ img: HTMLImageElement; rec: ImgRecord; target: number; worldW: number; worldH: number }> = [];

    for (let i = 0; i < imgs.length; i += 1) {
      const img = imgs[i]!;
      const rec = syncRecord(img);
      if (rec === null) continue;

      const card = img.closest<HTMLElement>("[data-lalala-card]");
      if (card === null || card.hasAttribute("data-lalala-card-off")) {
        plan.push({ img, rec, target: 0, worldW: 0, worldH: 0 });
        continue;
      }

      const rect = img.getBoundingClientRect();
      let bodyRect: DOMRect | undefined;
      const body = img.closest<HTMLElement>("[data-lalala-card-body]");
      if (body !== null) {
        bodyRect = bodyRects.get(body);
        if (bodyRect === undefined) {
          bodyRect = body.getBoundingClientRect();
          bodyRects.set(body, bodyRect);
        }
      }

      let w = rect.width;
      let h = rect.height;
      const worldW = z > 0 ? w / z : 0;
      const worldH = z > 0 ? h / z : 0;
      if (w === 0 && h === 0) {
        // Brand-new unloaded <img> with no CSS size yet vs. display:none inside closed tabs/details.
        const parent = img.parentElement;
        const parentRect = parent?.getBoundingClientRect();
        if (!parentRect || (parentRect.width === 0 && parentRect.height === 0)) {
          plan.push({ img, rec, target: 0, worldW: 0, worldH: 0 });
          continue;
        }
        let cRect = cardRects.get(card);
        if (cRect === undefined) {
          cRect = card.getBoundingClientRect();
          cardRects.set(card, cRect);
        }
        // Check if parent is within viewport + margin.
        const parentInView =
          parentRect.right >= -marginX &&
          parentRect.left <= viewW + marginX &&
          parentRect.bottom >= -marginY &&
          parentRect.top <= viewH + marginY;
        if (!parentInView) {
          plan.push({ img, rec, target: 0, worldW: 0, worldH: 0 });
          continue;
        }
        w = parentRect.width || cRect.width;
        h = parentRect.height || cRect.height;
      } else {
        // Check intersection with viewport expanded by margin.
        const inView =
          rect.right >= -marginX &&
          rect.left <= viewW + marginX &&
          rect.bottom >= -marginY &&
          rect.top <= viewH + marginY;
        if (!inView) {
          plan.push({ img, rec, target: 0, worldW, worldH });
          continue;
        }
        // Check intersection with the scrolling card body clip expanded by margin.
        if (bodyRect !== undefined) {
          const inBody =
            rect.bottom >= bodyRect.top - marginY &&
            rect.top <= bodyRect.bottom + marginY &&
            rect.right >= bodyRect.left - marginX &&
            rect.left <= bodyRect.right + marginX;
          if (!inBody) {
            plan.push({ img, rec, target: 0, worldW, worldH });
            continue;
          }
        }
      }

      const proxyable = !failedProxy.has(rec.originalSrc) && canProxyLod(rec.originalSrc, location.origin, proxyEnabled);
      const target = proxyable
        ? chooseLodBucket({
            screenCssW: w,
            screenCssH: h,
            zoom: z,
            dpr,
            phone,
            inModal: false,
            forceFull: false,
          })
        : Infinity;
      plan.push({ img, rec, target, worldW, worldH });
    }

    // Phase 2: Apply writes (culls, immediate loads, smooth upgrades, memory-reclaiming downgrades).
    for (const { img, rec, target, worldW, worldH } of plan) {
      if (target === 0) {
        cancelPreload(rec);
        if (rec.bucket !== 0) {
          if (img.complete && img.naturalWidth > 16 && img.naturalHeight > 16) {
            rec.natW = img.naturalWidth;
            rec.natH = img.naturalHeight;
          }
          // Preserve box size for scrolled-out images inside drawn cards so scrollHeight never jumps.
          if (worldW > 16 && worldH > 16 && rec.savedWidth === null) {
            rec.savedWidth = img.style.width;
            rec.savedHeight = img.style.height;
            img.style.width = `${Math.round(worldW)}px`;
            img.style.height = `${Math.round(worldH)}px`;
          }
          applySrc(img, rec, placeholderDataUrl(rec.natW, rec.natH), 0);
        }
        continue;
      }

      if (rec.savedWidth !== null) {
        img.style.width = rec.savedWidth;
        img.style.height = rec.savedHeight ?? "";
        rec.savedWidth = null;
        rec.savedHeight = null;
      }

      const nextUrl = urlForBucket(rec.originalSrc, target);
      if (rec.bucket === 0 || rec.appliedSrc === rec.originalSrc && target < Infinity && !img.complete) {
        // Entering viewport or newly mounted image: switch immediately so full-res never decodes!
        cancelPreload(rec);
        applySrc(img, rec, nextUrl, target);
        continue;
      }

      if (target > rec.bucket) {
        if (!allowUpgrade) continue;
        if (rec.preloadBucket === target && rec.preload !== null) continue;
        cancelPreload(rec);
        const pre = new Image();
        pre.decoding = "async";
        activePreloads.add(pre);
        rec.preload = pre;
        rec.preloadBucket = target;
        pre.onload = () => {
          const nw = pre.naturalWidth;
          const nh = pre.naturalHeight;
          const current = rec.preload === pre;
          // Immediately drop the off-DOM decoded buffer so memory never doubles!
          releasePreload(pre);
          if (!current) return;
          rec.preload = null;
          rec.preloadBucket = 0;
          if (rec.bucket === 0) return; // Culled while preloading.
          if (nw > 16 && nh > 16) {
            rec.natW = nw;
            rec.natH = nh;
          }
          applySrc(img, rec, nextUrl, target);
          pulseSharpen();
        };
        pre.onerror = () => {
          const current = rec.preload === pre;
          releasePreload(pre);
          if (!current) return;
          rec.preload = null;
          rec.preloadBucket = 0;
          if (target !== Infinity) {
            failedProxy.add(rec.originalSrc);
            applySrc(img, rec, rec.originalSrc, Infinity);
            pulseSharpen();
          }
        };
        pre.src = nextUrl;
      } else if (target < rec.bucket) {
        if (!allowDowngrade && rec.appliedSrc !== rec.originalSrc) continue;
        if (rec.appliedSrc === rec.originalSrc || shouldDowngrade(rec.bucket, target, phone)) {
          cancelPreload(rec);
          applySrc(img, rec, nextUrl, target);
        }
      }
    }

    updateVideos(phone);
  };

  const schedule = (zoomChanged: boolean) => {
    if (zoomChanged) {
      lastZoomChangeAt = performance.now();
      window.clearTimeout(upgradeTimer);
      window.clearTimeout(downgradeTimer);
      upgradeTimer = window.setTimeout(() => evaluate(true, false), UPGRADE_SETTLE_MS);
      downgradeTimer = window.setTimeout(() => evaluate(true, true), DOWNGRADE_SETTLE_MS);
    }
    if (raf === 0) {
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const settled = performance.now() - lastZoomChangeAt >= UPGRADE_SETTLE_MS;
        evaluate(settled, false);
      });
    }
  };

  const onStore = () => {
    const z = getCamera().z;
    const zoomChanged = z !== lastZoom;
    lastZoom = z;
    schedule(zoomChanged);
  };

  // Intercept newly mounted <img> elements synchronously in the mutation microtask before paint,
  // cancelling any full-resolution download before WebKit decodes a 97 MB bitmap!
  const observer = new MutationObserver((mutations) => {
    let touched = false;
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.attributeName === "src" && m.target instanceof HTMLImageElement) {
          const rec = records.get(m.target);
          if (rec && m.target.getAttribute("src") === rec.appliedSrc) continue;
        }
        touched = true;
        break;
      }
      if (m.addedNodes.length > 0) {
        touched = true;
        break;
      }
    }
    if (touched) evaluate(true, false);
  });
  observer.observe(world, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-lalala-card-off", "open"],
  });

  const onScroll = () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => evaluate(true, true), SCROLL_DEBOUNCE_MS);
  };
  world.addEventListener("scroll", onScroll, { capture: true, passive: true });

  // If a proxied WebP thumbnail fails for any reason, fall back immediately to the original image.
  const onError = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const rec = records.get(target);
    if (!rec || rec.bucket === 0 || rec.bucket === Infinity) return;
    failedProxy.add(rec.originalSrc);
    cancelPreload(rec);
    applySrc(target, rec, rec.originalSrc, Infinity);
  };
  world.addEventListener("error", onError, true);

  const unsubscribe = subscribe(onStore);
  evaluate(true, true);

  return () => {
    for (const pre of [...activePreloads]) releasePreload(pre);
    unsubscribe();
    observer.disconnect();
    world.removeEventListener("scroll", onScroll, true);
    world.removeEventListener("error", onError, true);
    window.cancelAnimationFrame(raf);
    window.cancelAnimationFrame(sharpenFrame);
    window.clearTimeout(upgradeTimer);
    window.clearTimeout(downgradeTimer);
    window.clearTimeout(scrollTimer);
    window.clearTimeout(sharpenTimer);
  };
}
