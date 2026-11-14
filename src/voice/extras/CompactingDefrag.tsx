import { useEffect, useEffectEvent, useRef, useState } from "react";
import { COLS, createDisk, defragPass, drawDisk } from "./defrag";
import "./compactingDefrag.css";
import "./cutFrame.css";

const STEP_MS = 150;
const REDUCED_POLL_MS = 1_000;
const FINISH_FRAME_MS = 33;
const DONE_HOLD_MS = 450;
// Each pass's pattern comes from the compaction's seed moved on by this.
const PASS_SEED_STEP = 7919;
// A narrow grid (a phone's room beside the label) takes fewer columns, so a block stays a block.
const MIN_CELL_PX = 6;

/**
 * The bar's room while the brain compacts its thread: a COMPACTING readout at the room's left end, then
 * a defrag paced by the estimate. A compaction that outlasts the estimate gets another pass
 * on a new pattern, again and again; when it ends the rest packs in under a second, then it goes. It
 * draws only when a block moves (about 7 times a second at most, 30 during the finish).
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
    const seed = read().startedAt ?? openedAt;
    const cols = Math.min(
      COLS,
      Math.max(12, Math.floor((canvas.clientWidth || Infinity) / MIN_CELL_PX)),
    );
    let pass = 0;
    let disk = createDisk(seed, cols);
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
        const at = defragPass(now - (startedAt ?? openedAt), estimateMs, DONE_HOLD_MS);
        if (!reduced && at.pass !== pass) {
          pass = at.pass;
          disk = createDisk(seed + pass * PASS_SEED_STEP, cols);
          step = -1;
        }
        show(reduced ? 0 : Math.floor(at.progress * disk.steps), !reduced && at.progress === 1);
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
      <span>
        <b data-cut="">Compacting</b>
      </span>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
