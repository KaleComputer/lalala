import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createDisk, defragProgress, drawDisk } from "./defrag";
import "./compactingDefrag.css";

const STEP_MS = 150;
const REDUCED_POLL_MS = 1_000;
const FINISH_FRAME_MS = 33;
const DONE_HOLD_MS = 450;

/**
 * "Compacting" in the bar's wave area while the brain compacts its thread: a defrag paced by the
 * estimate. When the compaction ends early the rest packs in under a second, then it goes. It draws
 * only when a block moves (about 7 times a second at most, 30 during the finish).
 */
export function CompactingDefrag(props: {
  readonly active: boolean;
  /** When the compaction started (epoch ms); null, when this view first showed it. */
  readonly startedAt: number | null;
  readonly estimateMs: number;
}) {
  // One showing per compaction; `run` changes for the next one so the clock starts over.
  const [view, setView] = useState({ shown: false, run: 0 });
  if (props.active && !view.shown) setView({ shown: true, run: view.run + 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const read = useEffectEvent(() => props);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paces the canvas against the clock and the compaction's end
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!view.shown || canvas === null) return;
    const openedAt = Date.now();
    // Reduced motion: one still grid while it runs, done at once when it ends.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const disk = createDisk(read().startedAt ?? openedAt);
    const style = getComputedStyle(canvas);
    const colors = {
      block: style.color,
      head: style.getPropertyValue("--defrag-head").trim() || "#ffc14d",
    };
    let step = -1;
    let width = 0;
    let finish: { readonly from: number; readonly at: number; readonly ms: number } | null = null;
    let timer = 0;
    // Draws only when a block moved or the bar changed size.
    const show = (next: number, done = false) => {
      if (next === step && canvas.clientWidth === width && !done) return;
      step = next;
      width = canvas.clientWidth;
      drawDisk(canvas, disk, next, colors, done);
    };
    const tick = () => {
      const now = Date.now();
      const { active, startedAt, estimateMs } = read();
      if (active && finish === null) {
        show(
          reduced ? 0 : Math.floor(defragProgress(now - (startedAt ?? openedAt), estimateMs) * disk.steps),
        );
        timer = window.setTimeout(tick, reduced ? REDUCED_POLL_MS : STEP_MS);
        return;
      }
      finish ??= {
        from: Math.max(0, step),
        at: now,
        ms: reduced ? 0 : 250 + 650 * (1 - Math.max(0, step) / disk.steps),
      };
      const t = Math.min(1, (now - finish.at) / finish.ms);
      if (t < 1) {
        show(Math.floor(finish.from + (disk.steps - finish.from) * t));
        timer = window.setTimeout(tick, FINISH_FRAME_MS);
        return;
      }
      show(disk.steps, true);
      timer = window.setTimeout(
        () => setView((current) => ({ ...current, shown: false })),
        DONE_HOLD_MS,
      );
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [view]);

  if (!view.shown) return null;
  return (
    <div data-lalala-defrag="" role="status">
      <canvas ref={canvasRef} aria-hidden="true" />
      <span data-lalala-plate="">Compacting</span>
    </div>
  );
}
