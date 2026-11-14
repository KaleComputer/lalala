import { screenLoading, subscribe } from "./canvasStore";

declare global {
  /** The page's boot screen (index.html), while it is up: its bar's share, then a fade out. */
  var __lalalaBoot: { progress(share: number): void; done(): void } | undefined;
}

/** The on-screen cards' content is this much of the bar; their pictures and fonts the rest. */
const CARDS_SHARE = 0.9;
/** A picture or font that is slow doesn't keep the canvas hidden longer than this. */
const MEDIA_MS = 1_500;

/** Decoded pictures on the screen itself, in the cards drawn now. */
function pictures(): Promise<unknown>[] {
  const waits: Promise<unknown>[] = [];
  for (const img of document.querySelectorAll<HTMLImageElement>(
    "[data-lalala-card]:not([data-lalala-card-off]) img",
  )) {
    const box = img.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth)
      continue;
    if (img.complete && img.naturalWidth > 0) continue;
    waits.push(img.decode().catch(() => {}));
  }
  return waits;
}

/**
 * Hands the boot screen over to the canvas the moment what's on the screen is in: its bar follows
 * the cards on screen getting their content, then their pictures and fonts (briefly), and one
 * painted frame later it ends. Cards just off the screen keep loading behind the canvas. Once per
 * page.
 */
export function followBootScreen() {
  const boot = globalThis.__lalalaBoot;
  if (boot === undefined) return;
  globalThis.__lalalaBoot = undefined;
  let finishing = false;
  let stop = () => {};

  const finish = async () => {
    finishing = true;
    const waits = pictures();
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
    // One frame for the last of it to paint under the logo.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    stop();
    boot.done();
  };

  const report = () => {
    if (finishing) return;
    const loading = screenLoading();
    if (loading === null) void finish();
    else
      boot.progress(
        loading.onScreen > 0
          ? (CARDS_SHARE * (loading.onScreen - loading.waiting)) / loading.onScreen
          : 0,
      );
  };
  stop = subscribe(report);
  report();
}
