// From Presence's call-frame bar, recoloured green.
// The call frame's wave (v3, 21 Oct; media/presence/cyberpunk-call, mockups/call.html drawWave): the
// line in the frame's main room at /, one 2D canvas inside the frame, as tall as the old wave
// (--bar-wave) around the room's middle. Every line runs the room edge to edge, from the left end
// (the red strip) to the key's straight divider, and is drawn only inside the room's shape (the cut
// corner, the divider); only her voice wave glows past the top and bottom edges (the user, 22 Oct: "make
// sure that the line and whatever we add are rendered in this box and fill it from left to right, so
// they touch the box and are not floating inside it").
// the user, 21 Oct: "why are the line animations not updated as in the cyberpunk design? i love those".
// the user, 22 Oct: "The style is good, but it's not auto-reactive anymore; it just feels like something
// random ... change it back so the line reacts to my voice". So the voice lines move only with sound:
// silence is a calm flat line, loud speech a clearly bigger one, as the old line did.
// One kind per look of the frame (frame.mjs), `waveKind`:
//   idle         nothing (the room is START CALL)      connecting  the line as ASCII, edge to edge (asciiline.mjs: cd87111's shader, back 23 Oct)
//   working      (thinking) beads on a faint thread, edge to edge, a light sweeping along them and out through both ends
//   speaking     the big amber voice wave: her playback
//   quiet        listening: no line at all, only the warm wash; his microphone never moves it (the user, 23 Oct)
//   stopped      the wave cut by a red tick, its tail knocked loose
//   no signal    the split glitch line: a cyan and a red copy apart, jumping (the one error look)
//   reading      (a reading in parts) the voice wave, softer
//   learning his voice: her voice while she speaks (frame.audio), else no line (quiet)
//   none         typing: the field takes the room
// Real audio (23 Oct, the user: "it just triggers the same animation whenever speech plays ... use the actual
// FFT or waveform values from the audio, live"): her voice line is the
// mockup's stroke (a glowing amber line and its faint ghost) through the voice's own waveform, read
// every frame from the analyser's time-domain samples (wave.mjs scopeFrom: a 24 ms window started at a
// rising zero crossing, soft-clipped, gated flat under a hiss floor), lightly eased between frames,
// under a taper that keeps both ends on the room's middle. No canned motion: silence is a dead flat
// line, a loud voice a clearly taller one. Her line reads what plays (playback.mjs; a waiting thread's
// reply read aloud too, and the SDK's analysers while the page's context stalls), our analyser on the
// stream already open (no second capture). The ghost is the same line a moment behind. Only she moves
// the line (the user, 23 Oct correction: the wave moves only while Presence speaks to him, flat while he
// talks; later that day: "not flat, not drawn at all"): listening draws no line, only the wash, and his microphone moves neither (its RMS is
// still read, for the checks). The tab's level bars are the spectrum's 64 bands in four groups.
// Reduced motion: every kind still, drawn only when it changes; the
// bars and the wash hold still. One canvas, sized only when its box changes (ResizeObserver), no layout
// read per frame; nothing drawn while the kind is none. Out of a call with nothing moving the page
// polls instead of drawing every frame (`resting`).

import { WAVE_N, WAVE_EASE, SCOPE_GAIN, bandsFrom, soften, scopeFrom } from "./wave.js";
import { createAsciiLine } from "./asciiline.js";

const AMB = "170, 255, 200";
const GLOW = "rgba(80, 255, 150,.9)";
const RED = "120, 255, 170";
const CYAN = "78,240,238";
const HUD = "61, 255, 143";
const ASCII = " .:-=+*#";
const N = 160; // samples along the line
/** The wash in the room per look (the mockup's): listening (the user talking or not, one look), stopped, learning. */
export const WASH = Object.freeze({ listening: 0.7, stopped: 0.35, learning: 0.55 });
/** Her line at full voice, of the canvas's height above the middle. */
export const VOICE_AMP = 0.4;
// The line between frames: eased only lightly (a frame or two), the ghost a moment behind it.
const LINE_EASE = 40;
const GHOST_EASE = 9;
// Her live line's stroke, built once: the mockup's.
const HER_STYLE = Object.freeze({ width: 1.9, blur: 16, stroke: `rgba(${AMB},0.95)`, ghost: `rgba(${AMB},0.25)` });
// the user's bands: up within a frame or two, down more slowly so syllables read as one movement.
const LISTEN_EASE = Object.freeze({ ...WAVE_EASE, up: 110, down: 12 });

/** Which wave the frame's look draws: `look` and `audio` (whose sound is on the line) from frame.mjs, a reading in parts, the frame open to type. */
export function waveKind({ look, audio = "", reading = false, open = false }) {
  if (open) return "none";
  const voice = reading ? "voice-soft" : "voice";
  switch (look) {
    case "":
    case "idle": return "idle";
    case "connecting": return "ascii";
    case "working": return "beads";
    case "speaking":
    case "thread": return voice;
    case "stopped": return "cut";
    case "nosignal": return "glitch";
    // Listening: no line at all, only the warm wash; the line is there only while she talks (the user, 23 Oct).
    case "listening": return "quiet";
    // A motion moment over the call: her line while she speaks, else no line.
    case "learning": return audio === "her" ? voice : "quiet";
    default: return "none";
  }
}
/** The wash's share for a look (typing has none). */
export const washOf = ({ look, open = false }) => (open ? 0 : WASH[look] ?? 0);

const rnd = (i) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const shaped = (v) => Math.min(1, Math.pow(Math.max(0, v) * 1.8, 0.75));
/** The mockup's voice: four sines under a window, soft-clipped so it never flat-tops; `env` its loudness at u. */
const voiceAt = (u, t, amp, env) => {
  const win = Math.pow(Math.sin(Math.PI * u), 1.6);
  const v = Math.sin(u * 19 + t * 7.1) * 0.45 + Math.sin(u * 41 - t * 11.3) * 0.3 + Math.sin(u * 7 + t * 3.2) * 0.5 + Math.sin(u * 83 + t * 17) * 0.12;
  return Math.tanh(2 * v * win * env * 1.15) * amp;
};
const fakeEnv = (u, t) => 0.55 + 0.45 * Math.sin(t * 2.3 + u * 2);
/** The taper over a live line: 1 over most of it, down to 0 at both ends so they sit on the middle. */
const taper = (u) => Math.min(1, 4 * Math.sin(Math.PI * u));

/**
 * `createCallWave(canvas, { reduced, wash, state, bars })`: `state()` says what the frame shows
 * ({ look, holding, reading, open }); `wash` is the room's wash element; `bars()` the tab's level bars
 * element now, if any. The page calls `frame(levels, spectrum)` once per animation frame.
 */
export function createCallWave(canvas, { reduced = false, wash = null, state = () => ({ look: "idle" }), bars = () => null } = {}) {
  const ctx = canvas.getContext("2d");
  const xs = new Float32Array(N + 1);
  const ys = new Float32Array(N + 1);
  const outBands = new Float32Array(WAVE_N);
  const outSoft = new Float32Array(WAVE_N);
  const inBands = new Float32Array(WAVE_N);
  const inSoft = new Float32Array(WAVE_N);
  // Her live line (N+1 points, -1..1): this frame's scope, the eased line drawn, its ghost. the user's scope is
  // read only for its RMS (checks); it is never drawn.
  const herScope = new Float32Array(N + 1);
  const herLine = new Float32Array(N + 1);
  const herGhost = new Float32Array(N + 1);
  const timScope = new Float32Array(N + 1);
  const flat = new Float32Array(N + 1);
  let W = 0;
  let H = 0;
  let dpr = 1;
  let kind = "";
  let kindAt = 0;
  let drawn = ""; // reduced motion: what the canvas holds (kind and size)
  let cleared = false;
  let out = 0; // her voice, eased 0..1
  let inp = 0; // the user's microphone, eased 0..1
  let spec = 0; // 0..1: how much her live spectrum shapes her wave along the line
  let specIn = 0; // the same for the user's
  const rms = { her: 0, tim: 0 }; // the waveforms' RMS this frame (checks)
  let drawnAmp = 0; // the highest point of the voice line drawn last (CSS px from the middle; checks)
  let span = null; // where the line drawn last starts and ends along the room (CSS px; checks)
  // The frame's room in the canvas's CSS px (bar.css .fr-wv): the canvas starts at the room's left end and
  // ends on the key's divider; the room is --bar-row tall around the canvas's middle, its top-left corner
  // cut by --cut less the strip, its right end the divider, straight (the user, 23 Oct).
  let room = { top: 0, bottom: 0, cut: 0 };
  let washNow = 0;
  let washSet = "";
  let barsSet = "";
  let voice = "idle";
  let moving = false; // her line or its ghost still off the middle
  let resting = false; // nothing here moves without sound: the page may poll instead of drawing every frame
  let asciiGl; // the restored ASCII shader (asciiline.mjs), made on the first connecting frame; null without WebGL
  let asciiBy = ""; // what drew the connecting line last: "webgl2", "webgl" or "2d" (checks)
  const start = performance.now();
  let last = start;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    const bw = Math.max(1, Math.round(W * dpr));
    const bh = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const cs = typeof getComputedStyle === "function" && canvas instanceof Element ? getComputedStyle(canvas) : null;
    const px = (name, or) => {
      const v = parseFloat(cs?.getPropertyValue(name));
      return Number.isFinite(v) ? v : or;
    };
    const rh = Math.min(H, px("--bar-row", H));
    room = { top: (H - rh) / 2, bottom: (H + rh) / 2, cut: Math.max(0, px("--cut", 0) - px("--fr-strip", 0)) };
    drawn = "";
    cleared = false;
  }
  resize();
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(canvas);

  /** One stroke through the samples filled by `f(u)` (CSS px above the middle) from `from` to `to`. */
  function stroke(from, to, f, width, alpha, blur = 10, col = AMB) {
    const cy = H / 2;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      xs[i] = from + (to - from) * u;
      ys[i] = cy - f(u);
    }
    path(width, `rgba(${col},${alpha})`, blur);
  }

  /** The stroke through xs/ys as they stand. */
  function path(width, style, blur) {
    ctx.save();
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = blur;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i <= N; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.stroke();
    ctx.restore();
  }

  /** A live line through the room: `line` (N+1 points, -1..1) times `amp` under the taper, point for point; returns its highest point. */
  function liveStroke(a, b, line, amp, width, style, blur) {
    const cy = H / 2;
    let peak = 0;
    for (let i = 0; i <= N; i++) {
      const y = line[i] * taper(i / N) * amp;
      if (Math.abs(y) > peak) peak = Math.abs(y);
      xs[i] = a + ((b - a) * i) / N;
      ys[i] = cy - y;
    }
    path(width, style, blur);
    return peak;
  }

  /** A voice line: its glowing stroke through the live points and its faint ghost a moment behind; the highest point kept for the checks. */
  function voiceLine(a, b, amp, line, ghostLine) {
    drawnAmp = liveStroke(a, b, line, amp, HER_STYLE.width, HER_STYLE.stroke, HER_STYLE.blur);
    liveStroke(a, b, ghostLine, amp * 0.6, 1, HER_STYLE.ghost, 0);
  }

  /** The room's outline: its cut corner and the divider; `open` lets her wave glow past the top and bottom edges. */
  function roomPath(open) {
    const { top, bottom, cut } = room;
    ctx.beginPath();
    if (open) {
      ctx.moveTo(0, 0);
      ctx.lineTo(W, 0);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
    } else {
      ctx.moveTo(cut, top);
      ctx.lineTo(W, top);
      ctx.lineTo(W, bottom);
      ctx.lineTo(0, bottom);
      ctx.lineTo(0, top + cut);
    }
    ctx.closePath();
  }

  function draw(k, t, lt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawnAmp = 0;
    span = null;
    if (k === "none") return;
    ctx.save();
    roomPath(k === "voice" || k === "voice-soft");
    ctx.clip();
    paint(k, t, lt);
    ctx.restore();
  }

  function paint(k, t, lt) {
    // The line's ends: the room's left end and the divider, so it touches the frame on both sides.
    const a = 0, b = W, L = b - a, cy = H / 2, mid = (a + b) / 2;
    // Out of a call the room is START CALL (the user, 23 Oct, variant 5: bar.css .fr-idle); listening is the
    // wash alone (the user, 23 Oct: the line is not drawn at all while she listens). No line over either.
    if (k === "idle" || k === "quiet") return;
    span = [a, b];
    if (k === "ascii") {
      // The old ASCII shader (the user, 23 Oct: "the one we had before"), copied into the room's clip.
      if (asciiGl === undefined) asciiGl = createAsciiLine();
      const img = asciiGl?.draw({ width: W, height: H, dpr, x0: a, x1: b, y: cy, time: t, breath: 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 7) });
      if (img) {
        asciiBy = asciiGl.kind;
        ctx.drawImage(img, 0, 0, W, H);
        return;
      }
      // Without WebGL: #168's glyph static.
      asciiBy = "2d";
      ctx.font = "600 9px 'Geist Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const half = L * 0.3 + Math.min(1, lt / 1.2) * L * 0.2;
      for (let px = mid - half; px <= mid + half; px += 7) {
        const u = (px - (mid - half)) / (2 * half);
        const g = Math.floor(rnd(Math.round(px) + Math.floor(t * 12) * 13) * 8 * Math.sin(Math.PI * u)) % 8;
        ctx.fillStyle = `rgba(${AMB},${(0.25 + 0.45 * rnd(px * 3 + Math.floor(t * 9))).toFixed(3)})`;
        ctx.fillText(ASCII[Math.max(1, g)], px, cy);
      }
      return;
    }
    if (k === "beads") {
      // Thinking: a faint thread from end to end with the beads on it, the first and last on the frame's
      // edges; the light runs in from the left end and out at the divider.
      const n = W < 500 ? 30 : 50;
      const speed = reduced ? 3 : 1.6;
      const pos = ((t % speed) / speed) * 1.3 - 0.15;
      ctx.save();
      ctx.strokeStyle = `rgba(${AMB},.2)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a, cy);
      ctx.lineTo(b, cy);
      ctx.stroke();
      ctx.restore();
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1), d = (u - pos) / 0.07, g = Math.exp(-d * d), al = 0.14 + (reduced ? 0.5 : 0.85) * g;
        ctx.save();
        ctx.shadowColor = GLOW;
        ctx.shadowBlur = 10 * al;
        ctx.fillStyle = `rgba(${AMB},${al.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(a + u * L, cy, 1.4 + 1.2 * g, 0, 7);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    if (k === "voice" || k === "voice-soft") {
      const amp = (k === "voice" ? VOICE_AMP : VOICE_AMP * 0.65) * H;
      if (reduced) {
        // Still: the mockup's settled voice.
        stroke(a, b, (u) => voiceAt(u, t, amp, fakeEnv(u, 0)), 1.9, 0.95, 16);
        stroke(a, b, (u) => voiceAt(u, t - 0.08, amp, fakeEnv(u, 0)) * 0.6, 1, 0.25, 0);
        return;
      }
      voiceLine(a, b, amp, herLine, herGhost);
      return;
    }
    if (k === "cut") {
      // Frozen where she was cut off; the tail knocked loose, down and right.
      const amp = 0.26 * H, cutX = 0.58;
      stroke(a, a + L * cutX, (u) => voiceAt(u * cutX, 1.7, amp, fakeEnv(u * cutX, 1.7)) * (1 - u * 0.6), 1.6, 0.7, 8);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.translate(6, 7);
      stroke(a + L * cutX, b, (u) => voiceAt(cutX + u * (1 - cutX), 1.7, amp, fakeEnv(cutX + u * (1 - cutX), 1.7)) * 0.4, 1.2, 0.35, 0, RED);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = `rgba(${HUD},.9)`;
      ctx.shadowColor = `rgba(${HUD},.8)`;
      ctx.shadowBlur = 8;
      ctx.fillRect(a + L * cutX - 0.6, cy - 18, 1.4, 36);
      ctx.restore();
      return;
    }
    if (k === "glitch") {
      const ph = Math.floor(t * 14);
      const base = (u) => (rnd(Math.floor(u * 24) + ph * 31) - 0.5) * 12 * (rnd(ph * 7 + Math.floor(u * 6)) > 0.55 ? 1 : 0.1);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      stroke(a - 3, b - 3, base, 1.4, 0.7, 0, CYAN);
      stroke(a + 3, b + 3, base, 1.4, 0.7, 0, HUD);
      stroke(a, b, base, 1.2, 0.45, 6);
      ctx.restore();
    }
  }

  /** The tab's level bars: the user's microphone, or her voice for her amber bars, in four groups of the same bands; a transform each, no layout. */
  function paintBars() {
    const el = bars();
    if (!el) return void (barsSet = "");
    if (reduced) return;
    el.toggleAttribute("data-live", true);
    const amb = el.classList.contains("amb");
    const [soft, sp, lvl] = amb ? [outSoft, spec, out] : [inSoft, specIn, inp];
    const n = el.children.length || 1;
    let key = amb ? "a" : "t";
    for (let i = 0; i < el.children.length; i++) {
      let g = 0;
      const from = Math.floor((i * WAVE_N) / n), to = Math.floor(((i + 1) * WAVE_N) / n);
      for (let j = from; j < to; j++) g += soft[j];
      g /= Math.max(1, to - from);
      const v = (1 - sp) * lvl + sp * Math.min(1, g * 1.6);
      key += `,${(0.2 + 0.8 * Math.min(1, v * 1.3)).toFixed(2)}`;
    }
    if (key === barsSet) return;
    barsSet = key;
    const s = key.split(",");
    for (let i = 0; i < el.children.length; i++) el.children[i].style.transform = `scaleY(${s[i + 1]})`;
  }

  /** The wash: its share for the look, still (his voice does not move it); written only on change. */
  function paintWash(st, t, dt) {
    if (!wash) return;
    const to = washOf(st);
    washNow = reduced ? to : washNow + (to - washNow) * ease(7, dt);
    const o = Math.min(1, washNow);
    const v = o < 0.002 ? "0" : o.toFixed(3);
    if (v === washSet) return;
    washSet = v;
    wash.style.opacity = v;
    wash.style.transform = "";
  }

  function frame(levels = {}, spectrum = null) {
    const now = performance.now();
    const dt = Math.min(1 / 20, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000 + 1.3;
    const st = state();
    const k = waveKind(st);
    if (k !== kind) (kind = k), (kindAt = now), (cleared = false);
    const lt = (now - kindAt) / 1000;

    // The real audio: her playback (our analyser's spectrum, else the session's output level) and the user's
    // microphone (our analyser on the shared stream, else its level). Quick to rise, slower to fall.
    const outData = reduced ? null : spectrum?.output ?? null;
    const inData = reduced ? null : spectrum?.input ?? null;
    spec += ((outData ? 1 : 0) - spec) * ease(6, dt);
    specIn += ((inData ? 1 : 0) - specIn) * ease(6, dt);
    bandsFrom(outData, outBands, dt);
    bandsFrom(inData, inBands, dt, LISTEN_EASE);
    soften(outBands, outSoft);
    soften(inBands, inSoft);
    let mean = 0;
    for (let j = 0; j < WAVE_N; j++) mean += outBands[j];
    mean /= WAVE_N;
    const outT = reduced ? 0 : Math.max(shaped(levels.output ?? 0), outData ? Math.min(1, mean * 1.6) : 0);
    const inT = reduced ? 0 : shaped(levels.input ?? 0);
    out += (outT - out) * ease(outT > out ? 7 : 2.2, dt);
    inp += (inT - inp) * ease(inT > inp ? 9 : 2.6, dt);
    // Her line: her voice's own waveform this frame (null, nothing plays: flat), lightly eased. the user's
    // microphone is read only for its RMS (checks): it never moves the line.
    rms.her = scopeFrom(reduced ? null : spectrum?.outputWave ?? null, spectrum?.outputRate ?? spectrum?.rate ?? 48000, herScope, SCOPE_GAIN.her);
    rms.tim = scopeFrom(reduced ? null : spectrum?.inputWave ?? null, spectrum?.inputRate ?? spectrum?.rate ?? 48000, timScope, SCOPE_GAIN.tim);
    const le = ease(LINE_EASE, dt), ge = ease(GHOST_EASE, dt);
    moving = false;
    for (let i = 0; i <= N; i++) {
      herLine[i] += (herScope[i] - herLine[i]) * le;
      herGhost[i] += (herLine[i] - herGhost[i]) * ge;
      if (!moving && Math.abs(herGhost[i]) > 1e-3) moving = true;
    }

    paintWash(st, t, dt);
    paintBars();
    resting = (kind === "idle" || kind === "none") && !moving && out < 0.002 && inp < 0.002 && Math.abs(washNow - washOf(st)) < 0.002;

    if (W < 2 || H < 2) return;
    if (kind === "none") {
      drawnAmp = 0;
      if (!cleared) ctx.setTransform(1, 0, 0, 1, 0, 0), ctx.clearRect(0, 0, canvas.width, canvas.height), (cleared = true);
      return;
    }
    if (reduced || resting) {
      // Still: the settled look of each kind (reduced motion), or idle at rest, drawn once.
      const key = `${reduced ? "" : "rest|"}${kind}|${W}x${H}`;
      if (key === drawn) return;
      drawn = key;
      return draw(kind, reduced ? 1.3 : t, 9);
    }
    drawn = "";
    draw(kind, t, lt);
  }

  return {
    frame,
    /** The old line's calls, kept so the page drives either: the frame places this canvas by CSS. */
    moveTo() {},
    flash() {},
    setVoice: (v) => void (voice = v),
    /** The kind drawn now, her and the user's eased levels, the voice line's highest point drawn (CSS px), the line's ends and the room (CSS px), the wash's opacity (checks). */
    get kind() {
      return kind;
    },
    get levels() {
      return { out, input: inp, spec, specIn, rms: { ...rms } };
    },
    /** Nothing here moves without sound (idle or none, the lines flat, the wash settled): the page may poll instead of drawing every frame. */
    get resting() {
      return resting;
    },
    /** The live line drawn now (her points, -1..1, before the taper; the user's always flat; checks). */
    line(who = "her") {
      return who === "tim" ? flat : herLine;
    },
    get drawn() {
      return drawnAmp;
    },
    get span() {
      return span && { from: span[0], to: span[1], width: W, height: H, ...room };
    },
    get wash() {
      return { shown: washNow, opacity: Number(wash?.style.opacity || 0) };
    },
    get voice() {
      return voice;
    },
    /** What drew the connecting line last: "webgl2" or "webgl" (the restored shader), "2d" (no WebGL), "" (not yet). */
    get ascii() {
      return asciiBy;
    },
    mode: "2d",
  };
}
