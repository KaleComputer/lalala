/**
 * While a field in the bar is open on the phone: the page's scale is capped (its text is under 16px,
 * which makes iOS zoom in on focus; pinch-zoom still works) and the keyboard (visual viewport) lifts
 * the bar over itself. Returns the undo.
 */
export function liftOverKeyboard(bar: HTMLElement): () => void {
  const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const viewportBefore = viewportMeta?.content ?? null;
  if (viewportMeta && !/maximum-scale/.test(viewportMeta.content))
    viewportMeta.content = `${viewportMeta.content}, maximum-scale=1`;
  const viewport = window.visualViewport;
  const lift = () => {
    if (!viewport) return;
    const keyboard = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
    if (keyboard > 40) bar.style.setProperty("--kb", `${keyboard}px`);
    else bar.style.removeProperty("--kb");
  };
  viewport?.addEventListener("resize", lift);
  viewport?.addEventListener("scroll", lift);
  lift();
  return () => {
    viewport?.removeEventListener("resize", lift);
    viewport?.removeEventListener("scroll", lift);
    bar.style.removeProperty("--kb");
    if (viewportMeta && viewportBefore !== null) viewportMeta.content = viewportBefore;
  };
}
