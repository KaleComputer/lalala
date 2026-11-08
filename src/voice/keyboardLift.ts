/**
 * While a field in the bar is open on the phone, the keyboard (visual viewport) lifts the bar over
 * itself. Its fields are 16px on touch (voiceBar.css), so iOS doesn't zoom in. Returns the undo.
 */
export function liftOverKeyboard(bar: HTMLElement): () => void {
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
  };
}
