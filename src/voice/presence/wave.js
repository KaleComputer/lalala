// From Presence's call-frame bar, recoloured green.
// Presence's voice wave: one pipeline for both voices, the user's (listening) and the
// agent's (speaking). An analyser's byte spectrum (fftSize 2048, 1024 bins, smoothing 0.8, as the
// ElevenLabs SDK sets up its own) goes into 64 log-spaced bands over the voice range only (to
// VOICE_TOP), each band its loudest bin, eased in time (fast up, a little slower down), blended with
// its neighbours so harmonics never comb, then laid once across the whole line, low notes left,
// under a window that keeps both ends put. Never mirrored: position u along the line is one band.
// The two voices differ only in height (light.mjs). Pure functions over preallocated arrays, no
// DOM and no allocation per frame: light.mjs runs it per frame and the tests feed it spectra.

import { VOICE_TOP } from "./speech-constants.js";

/** n+1 log-spaced bin edges from `start` to `top`, each band at least one bin wide. */
export function edges(n, top, start = 4) {
  const e = [];
  for (let j = 0; j <= n; j++) e.push(Math.max(j, Math.round(start * Math.pow(top / start, j / n))));
  for (let j = 1; j <= n; j++) e[j] = Math.max(e[j], e[j - 1] + 1);
  return e;
}

export const WAVE_N = 64; // bands once along the line, low notes left, over the voice range only
export const WAVE_EDGES = edges(WAVE_N, VOICE_TOP);
/** How the bands follow the spectrum: each band's loudest bin, the byte floor and the tilt. */
export const WAVE_EASE = Object.freeze({ up: 46, down: 16, floor: 0.36, tilt: 0.7 });

const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Band levels (0..1) from one byte spectrum into `bands`, eased in time; null data falls to 0. */
export function bandsFrom(data, bands, dt, { up, down, floor, tilt } = WAVE_EASE, edgesOf = WAVE_EDGES) {
  const n = bands.length;
  for (let j = 0; j < n; j++) {
    let v = 0;
    if (data) {
      const b = Math.min(data.length, edgesOf[j + 1]);
      for (let k = edgesOf[j]; k < b; k++) if (data[k] > v) v = data[k];
      // Bytes span -100 to -30 dB: lift the floor off, keep the peaks from all clipping to one.
      v = Math.max(0, (v / 255 - floor) / (1 - floor)) * (1 + tilt * (j / (n - 1)));
      // A soft knee instead of a clip, so loud speech never flattens into a plateau.
      v = 1 - Math.exp(-2.4 * v * v);
    }
    bands[j] += (v - bands[j]) * ease(v > bands[j] ? up : down, dt);
  }
}

/** Each band blended with its neighbours (1-2-1) into `soft`. */
export function soften(bands, soft) {
  const n = bands.length;
  for (let j = 0; j < n; j++) soft[j] = (bands[j > 0 ? j - 1 : 0] + 2 * bands[j] + bands[j < n - 1 ? j + 1 : n - 1]) / 4;
}

/** Catmull-Rom through `a` at position p (in samples), ends clamped. */
export function cr(a, p) {
  const n = a.length;
  const i = Math.floor(p);
  const t = p - i;
  const at = (k) => a[k < 0 ? 0 : k >= n ? n - 1 : k];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** The wave's height (0..1) at u (0..1) along the line: the softened bands under the window. */
export function waveAt(soft, u) {
  return Math.max(0, cr(soft, u * soft.length - 0.5)) * Math.pow(Math.sin(Math.PI * u), 0.6);
}

// The line itself (23 Oct, the user: "it just triggers the same animation whenever speech plays ... use the
// actual FFT or waveform values from the audio, live, for both listening and speaking"): the voice's own
// waveform, as an oscilloscope draws it. An analyser's time-domain samples (the last fftSize of them)
// give a window of SCOPE.ms, started at a rising zero crossing so a held vowel stands still instead of
// sliding, box-averaged into the line's points (no aliasing at 160 points), lifted by a gain and a gentle
// curve (a quiet voice still reads, a loud one clearly taller) and soft-clipped (never a flat top), and
// gated by the window's RMS so a room's hiss, a tail, silence lies dead flat. Pure, over preallocated arrays: no allocation per frame.

/** The scope: window length, the curve on each point's size, the RMS gate (below `floor` flat, full from `knee`). */
export const SCOPE = Object.freeze({ ms: 24, curve: 0.7, floor: 0.0015, knee: 0.006 });
/** Gains: the user's microphone runs quieter than her playback. */
export const SCOPE_GAIN = Object.freeze({ user: 6, her: 4 });
/** One point's height (-1..1) from a sample `v`: gain, the curve, a soft clip; the sign kept. */
export const scopeY = (v, gain, curve = SCOPE.curve) => (v < 0 ? -1 : 1) * Math.tanh(Math.pow(gain * Math.abs(v), curve));

/**
 * The line's points (-1..1) into `out` from `samples` (time-domain, -1..1) at `rate` Hz; returns the
 * window's RMS. `gain` and the curve lift each point before the soft clip (`scopeY`). Null samples (nothing plays) give a flat line.
 */
export function scopeFrom(samples, rate, out, gain = SCOPE_GAIN.her, { ms, curve, floor, knee } = SCOPE) {
  const m = out.length;
  if (!samples || samples.length < m) {
    out.fill(0);
    return 0;
  }
  const n = samples.length;
  const win = Math.max(m, Math.min(n, Math.round((rate * ms) / 1000)));
  const search = n - win;
  // The window's RMS (from the window's possible start; trigger shifts it by less than a period).
  let sq = 0;
  for (let i = 0; i < n; i++) sq += samples[i] * samples[i];
  const rms = Math.sqrt(sq / n);
  // A rising zero crossing of a lightly low-passed copy (a moving mean over ~0.5 ms), after it dipped
  // under a little hysteresis, so harmonics and hiss don't trigger it.
  const k = Math.max(1, Math.round(rate / 2000));
  const hys = rms * 0.3;
  let trig = 0;
  let acc = 0;
  let low = false;
  let prev = 0;
  for (let i = 0; i < k && i < n; i++) acc += samples[i];
  for (let i = k; i < search + k && i < n; i++) {
    acc += samples[i] - samples[i - k];
    const v = acc / k;
    if (v < -hys) low = true;
    else if (low && prev < 0 && v >= 0) {
      trig = i - (k >> 1);
      break;
    }
    prev = v;
  }
  const g = Math.min(1, Math.max(0, (rms - floor) / (knee - floor)));
  const gate = g * g * (3 - 2 * g);
  const step = win / m;
  for (let p = 0; p < m; p++) {
    const a = trig + Math.floor(p * step);
    const b = Math.min(n, Math.max(a + 1, trig + Math.floor((p + 1) * step)));
    let s = 0;
    for (let i = a; i < b; i++) s += samples[i];
    out[p] = gate === 0 ? 0 : scopeY(s / (b - a), gain, curve) * gate;
  }
  return rms;
}

/**
 * An analyser's time-domain samples (-1..1) into `out` (a Float32Array of its fftSize): the float read
 * where there is one, else the byte read (older WebKit) through `bytes`. Returns `out`.
 */
export function timeDomain(analyser, out, bytes = null) {
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(out);
    return out;
  }
  const b = bytes ?? new Uint8Array(out.length);
  analyser.getByteTimeDomainData(b);
  for (let i = 0; i < out.length; i++) out[i] = (b[i] - 128) / 128;
  return out;
}
