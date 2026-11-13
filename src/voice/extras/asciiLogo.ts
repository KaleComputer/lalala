/**
 * The page loader's one source: the 32×32 mark extruded into surface points, turned about Y,
 * projected and shaded with an ASCII ramp. lalala's index.html (the real boot screen), PageLoader
 * and the cards run it; plain DOM, no React, so the boot page can import it before the app.
 */
// prettier-ignore
const MARK = [0x007fffff,0x00ffffff,0x01ffffff,0x03ffffff,0x07e0000f,0x0fc0000f,0x1f80000f,0x3f00000f,0x7e00000f,0xfc00000f,0xf800000f,0xf000000f,0xf000000f,0xf000000f,0xf000fc0f,0xf001fc0f,0xf003fc0f,0xf003fc0f,0xf003fc0f,0xf003fc0f,0xf003f80f,0xf003f01f,0xf000003f,0xf000007e,0xf00000fc,0xf00001f8,0xf00003f0,0xf00007e0,0xffffffc0,0xffffff80,0xffffff00,0xfffffe00];
const W = 44;
const H = 24;
const T = 3;
const DIST = 72;
const RAMP = ".,-~:;=!*#$@";
/** The still angle: reduced motion, a failed load, and where the turn starts. */
const REST = 0.5;
/** Radians per millisecond. */
const SPIN = 0.0012;
/** One frame per this many ms at most (25 fps). */
const FRAME_MS = 40;

const on = (x: number, y: number) =>
  x >= 0 && x < 32 && y >= 0 && y < 32 && ((MARK[y]! >>> (31 - x)) & 1) === 1;

function surface(): Float32Array {
  const p: number[] = [];
  const add = (x: number, y: number, z: number, nx: number, ny: number, nz: number) =>
    p.push(x - 16, 16 - y, z, nx, ny, nz);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (!on(x, y)) continue;
      for (const a of [0.25, 0.75])
        for (const b of [0.25, 0.75]) {
          add(x + a, y + b, -T, 0, 0, -1);
          add(x + a, y + b, T, 0, 0, 1);
        }
      for (let z = -T; z <= T; z += 0.5)
        for (const a of [0.25, 0.75]) {
          if (!on(x - 1, y)) add(x, y + a, z, -1, 0, 0);
          if (!on(x + 1, y)) add(x + 1, y + a, z, 1, 0, 0);
          if (!on(x, y - 1)) add(x + a, y, z, 0, 1, 0);
          if (!on(x, y + 1)) add(x + a, y + 1, z, 0, -1, 0);
        }
    }
  return new Float32Array(p);
}

let pts: Float32Array | null = null;
const zbuf = new Float32Array(W * H);
const cells: string[] = Array.from({ length: W * H }, () => " ");
const tc = Math.cos(-0.22);
const ts = Math.sin(-0.22);

/** The mark at `angle` as W×H lines of text. */
function drawLogo(angle: number): string {
  pts ??= surface();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  zbuf.fill(0);
  cells.fill(" ");
  for (let i = 0; i < pts.length; i += 6) {
    const x = pts[i]!,
      y = pts[i + 1]!,
      z = pts[i + 2]!;
    const nx = pts[i + 3]!,
      ny = pts[i + 4]!,
      nz = pts[i + 5]!;
    const x1 = x * c + z * s,
      z1 = z * c - x * s,
      nx1 = nx * c + nz * s,
      nz1 = nz * c - nx * s;
    const y2 = y * tc - z1 * ts,
      z2 = y * ts + z1 * tc;
    const ny2 = ny * tc - nz1 * ts,
      nz2 = ny * ts + nz1 * tc;
    if (nz2 >= 0) continue;
    const k = DIST / (z2 + DIST);
    const col = (W / 2 + x1 * k) | 0,
      row = (H / 2 - y2 * k * 0.6) | 0;
    if (col < 0 || col >= W || row < 0 || row >= H) continue;
    const j = row * W + col;
    if (k <= zbuf[j]!) continue;
    zbuf[j] = k;
    const lum = -0.35 * nx1 + 0.45 * ny2 - 0.82 * nz2;
    cells[j] = RAMP[Math.max(0, Math.min(RAMP.length - 1, (lum * RAMP.length) | 0))]!;
  }
  let text = "";
  for (let r = 0; r < H; r++) text += cells.slice(r * W, r * W + W).join("") + "\n";
  return text;
}

const NOISE = "#@%&$/\\|<>_=+*01";

/** The frame torn up: bands of rows slipped sideways, glyphs corrupted, a row torn, a band dropped. */
function glitch(text: string, seed: number): string {
  let state = (seed * 2654435761) >>> 0 || 1;
  const rand = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
  const rows = text.split("\n").slice(0, H);
  const burst = rand() < 0.6;
  for (let band = burst ? 1 + ((rand() * 3) | 0) : 0; band > 0; band--) {
    const from = (rand() * H) | 0;
    const by = ((rand() * 15) | 0) - 7;
    for (let r = from; r < Math.min(H, from + 1 + ((rand() * 5) | 0)); r++) {
      const row = rows[r]!;
      rows[r] = by > 0 ? (" ".repeat(by) + row).slice(0, W) : row.slice(-by) + " ".repeat(-by);
    }
  }
  const rate = burst ? 0.12 : 0.03;
  for (let r = 0; r < H; r++) {
    let row = "";
    for (const ch of rows[r]!)
      row += ch !== " " && rand() < rate ? NOISE[(rand() * NOISE.length) | 0] : ch;
    rows[r] = row;
  }
  if (burst && rand() < 0.35) {
    const r = (rand() * (H - 1)) | 0;
    rows[r + 1] = rows[r]!;
  }
  if (rand() < 0.08) {
    const from = (rand() * H) | 0;
    for (let r = from; r < Math.min(H, from + 3); r++) rows[r] = " ".repeat(W);
  }
  return rows.join("\n") + "\n";
}

/**
 * Draws the mark into `target` and turns it until `stopWhen` says so (checked each frame) or the
 * returned stop is called; then it rests at the still angle. While `glitchWhen` says so it keeps
 * turning, torn up (a load that failed). Reduced motion draws still frames, clean or glitched.
 */
export function runLogo(
  target: HTMLElement,
  stopWhen: () => boolean = () => false,
  glitchWhen: () => boolean = () => false,
): () => void {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let glitching = glitchWhen();
  const rest = () => (glitching ? glitch(drawLogo(REST), 7) : drawLogo(REST));
  target.textContent = rest();
  let frame = 0;
  let start = 0;
  let last = 0;
  let count = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    glitching = false;
    target.textContent = drawLogo(REST);
  };
  const tick = (now: number) => {
    if (stopWhen()) return stop();
    frame = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    start ||= now;
    last = now;
    const was = glitching;
    glitching = glitchWhen();
    if (still) {
      if (glitching !== was) target.textContent = rest();
      return;
    }
    const text = drawLogo(REST + (now - start) * SPIN);
    target.textContent = glitching ? glitch(text, ++count) : text;
  };
  frame = requestAnimationFrame(tick);
  return stop;
}
