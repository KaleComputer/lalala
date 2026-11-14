import { canvasLoading, subscribe } from "./canvasStore";

declare global {
  /** The page's boot screen (index.html), while it is up: its bar's share, then a fade out. */
  var __lalalaBoot: { progress(share: number): void; done(): void } | undefined;
}

/** The cards' content is this much of the bar; their pictures, frames and fonts the rest. */
const CARDS_SHARE = 0.85;
/** A picture or frame that never answers doesn't hold the canvas back longer than this. */
const MEDIA_MS = 6_000;

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });

const idle = () =>
  new Promise<void>((resolve) =>
    "requestIdleCallback" in window
      ? requestIdleCallback(() => resolve(), { timeout: 1_000 })
      : setTimeout(resolve, 50),
  );

// A sandboxed card page (BrainCards) hides its document, so its load is noted as it happens.
const loadedFrames = new WeakSet<EventTarget>();
if (typeof document !== "undefined")
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLIFrameElement) loadedFrames.add(event.target);
    },
    true,
  );

/** Pictures decoded and card pages (iframes) loaded in the cards drawn now. */
function media(): Promise<unknown>[] {
  const waits: Promise<unknown>[] = [];
  for (const card of document.querySelectorAll("[data-lalala-card]:not([data-lalala-card-off])")) {
    for (const img of card.querySelectorAll("img")) {
      // A lazy picture off screen (lower in a card's list) never loads, so it isn't waited for.
      const box = img.getBoundingClientRect();
      const onScreen =
        box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
      if (img.loading === "lazy" && !onScreen) continue;
      waits.push(img.decode().catch(() => {}));
    }
    for (const frame of card.querySelectorAll("iframe")) {
      if (loadedFrames.has(frame)) continue;
      waits.push(new Promise((resolve) => frame.addEventListener("load", resolve, { once: true })));
    }
  }
  return waits;
}

/**
 * Hands the boot screen over to the canvas. Its bar follows the cards near the screen coming in
 * (the count the map shows as "loading canvas"), then their pictures, card pages and fonts; after
 * two quiet frames and a short hold it fades out. Once per page.
 */
export function followBootScreen() {
  const boot = globalThis.__lalalaBoot;
  if (boot === undefined) return;
  globalThis.__lalalaBoot = undefined;
  let finishing = false;
  let stop = () => {};

  const finish = async () => {
    finishing = true;
    const waits = media();
    let settled = 0;
    const tick = () =>
      boot.progress(CARDS_SHARE + ((1 - CARDS_SHARE) * settled) / (waits.length + 1));
    for (const wait of waits)
      void wait.then(() => {
        settled += 1;
        tick();
      });
    tick();
    await Promise.race([
      Promise.all([...waits, document.fonts.ready]),
      new Promise((resolve) => setTimeout(resolve, MEDIA_MS)),
    ]);
    await frames(2);
    await idle();
    // More cards came near meanwhile (a layout answer, a late placement): follow them first.
    if (canvasLoading() !== null) {
      finishing = false;
      report();
      return;
    }
    boot.progress(1);
    stop();
    // The boot screen holds the logo 500 ms after its bar fades, so the last paint lands under it.
    boot.done();
  };

  const report = () => {
    if (finishing) return;
    const loading = canvasLoading();
    if (loading === null) void finish();
    else
      boot.progress(
        loading.near > 0 ? (CARDS_SHARE * (loading.near - loading.waiting)) / loading.near : 0,
      );
  };
  stop = subscribe(report);
  report();
}
