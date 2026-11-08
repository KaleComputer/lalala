// The bar's compacting view, as an old disk defragmenter: scattered blocks packed to the front one
// step at a time. Pure model and drawing, no React (CompactingDefrag drives it).

export const COLS = 48;
export const ROWS = 3;

export type Disk = {
  readonly used: readonly boolean[];
  /** The step that empties each cell (its block moved to the front), or Infinity. */
  readonly emptiedAt: readonly number[];
  /** The cell each step reads from, or -1 when its block was already in place. */
  readonly source: readonly number[];
  /** Steps to a packed disk: one per block. */
  readonly steps: number;
};

/** A fragmented disk, the same for the same seed; packing it front to back fills `steps` cells. */
export function createDisk(seed: number): Disk {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cells = COLS * ROWS;
  const used = Array.from({ length: cells }, () => random() < 0.6);
  const blocks = used.filter(Boolean).length;
  const emptiedAt = Array.from({ length: cells }, () => Infinity);
  const source = Array.from({ length: blocks }, () => -1);
  const now = [...used];
  let last = cells - 1;
  for (let step = 0; step < blocks; step++) {
    if (now[step]) continue;
    while (!now[last]) last--;
    now[last] = false;
    now[step] = true;
    emptiedAt[last] = step;
    source[step] = last;
  }
  return { used, emptiedAt, source, steps: blocks };
}

/**
 * How far the defrag is, 0 to 1, after `elapsedMs` of a compaction expected to take `estimateMs`:
 * even to 85% at the estimate, then ever slower toward 99%, so a long run eases instead of looping.
 */
export function defragProgress(elapsedMs: number, estimateMs: number): number {
  const t = Math.max(0, elapsedMs) / Math.max(1, estimateMs);
  return t <= 1 ? 0.85 * t : 0.85 + 0.14 * (1 - Math.exp(-(t - 1) / 0.8));
}

export type DefragColors = { readonly block: string; readonly head: string };

/** Draws the disk after `step` steps; at `steps` every block is packed, `done` lights them fully. */
export function drawDisk(
  canvas: HTMLCanvasElement,
  disk: Disk,
  step: number,
  colors: DefragColors,
  done: boolean,
): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (width === 0 || height === 0) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, width, height);
  const cellW = width / COLS;
  const cellH = height / ROWS;
  const gap = Math.max(1, Math.round(ratio * 1.5));
  const reading = step < disk.steps ? (disk.source[step] ?? -1) : -1;
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    // Column-major, like a disk map read left to right.
    const x = Math.floor(cell / ROWS) * cellW;
    const y = (cell % ROWS) * cellH;
    let color = colors.block;
    let alpha: number;
    if (cell < step) alpha = done ? 1 : 0.85;
    else if (cell === step && step < disk.steps) {
      color = colors.head;
      alpha = 1;
    } else if (cell === reading) {
      color = colors.head;
      alpha = 0.55;
    } else if (disk.used[cell] && (disk.emptiedAt[cell] ?? Infinity) >= step) alpha = 0.32;
    else alpha = 0.07;
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.fillRect(x + gap / 2, y + gap / 2, cellW - gap, cellH - gap);
  }
  context.globalAlpha = 1;
}
