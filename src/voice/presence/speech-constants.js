// From Presence's call-frame bar, recoloured green.
// Presence: only speech moves the listening wave. Taps, clicks and knocks on the table
// reach the microphone too; the line ignores them (what goes to ElevenLabs is untouched: this reads
// the SDK's analyser, it never filters the stream). Two parts, both on the SDK's input spectrum
// (1024 bins, 100 Hz to 8 kHz, linear, about 7.7 Hz a bin):
//   band   only bins up to about 3.5 kHz shape the wave (the voice range; the SDK's floor is 100 Hz),
//          the same as a band-pass in front of the analyser, for the animation only
//   gate   the line moves only while the sound is voiced: a voice is a comb of harmonics (a pitch of
//          85 to 400 Hz), a knock or a click is a few inharmonic modes or broadband noise. The gate
//          opens after the comb has held for about 80 ms (quick), and closes slowly once it is gone
//          for a moment, so syllables and the gaps between words keep it open.
// Pure functions of the bytes, no DOM: light.mjs runs it per frame and the tests feed it spectra.

/** The last bin of the voice band (about 3.5 kHz) in the SDK's 1024 bins over 100 Hz to 8 kHz. */
export const VOICE_TOP = 441;
const HARM_N = 260; // harmonics are searched up to about 2.1 kHz, where voiced speech is strongest
const LAG_MIN = 11; // pitch 85 Hz
const LAG_MAX = 52; // pitch 400 Hz

/**
 * How much the spectrum is a harmonic comb, 0..1: the strongest autocorrelation of its fine detail
 * (the spectrum less its local mean) over the lags a speaking pitch can have.
 */
export function harmonicity(data) {
  const r = harmonicity.r ?? (harmonicity.r = new Float32Array(HARM_N));
  let run = 0;
  let count = 0;
  for (let k = 0; k <= 6; k++) (run += data[k]), count++;
  let e = 0;
  for (let i = 0; i < HARM_N; i++) {
    r[i] = data[i] - run / count;
    e += r[i] * r[i];
    // Slide the 13-bin window one bin on.
    if (i + 7 < data.length) (run += data[i + 7]), count++;
    if (i - 6 >= 0) (run -= data[i - 6]), count--;
  }
  if (e < 1) return 0;
  let best = 0;
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    let a = 0;
    for (let i = 0; i + lag < HARM_N; i++) a += r[i] * r[i + lag];
    best = Math.max(best, (a / e) * (HARM_N / (HARM_N - lag)));
  }
  return Math.min(1, best);
}

const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

/**
 * A speech gate on the input spectrum: `update(data, dt)` gives 0..1, how much the listening wave
 * may move now. `data` null (no session) closes it.
 */
export function createSpeechGate({ open = 0.6, hold = 0.45, sustain = 0.08, linger = 0.3, loud = 80 } = {}) {
  let comb = 0; // harmonicity, eased over about 50 ms
  let held = 0; // how long the comb has been there, s
  let gone = 0; // how long it has been gone while open, s
  let on = false;
  let gate = 0;
  return {
    update(data, dt) {
      let peak = 0;
      if (data) for (let i = 0; i < VOICE_TOP; i++) peak = Math.max(peak, data[i]);
      const h = peak >= loud ? harmonicity(data) : 0;
      comb += (h - comb) * ease(20, dt);
      if (!on) {
        held = comb > open ? held + dt : 0;
        if (held >= sustain) (on = true), (gone = 0);
      } else {
        gone = comb > hold ? 0 : gone + dt;
        if (gone >= linger) (on = false), (held = 0);
      }
      gate += ((on ? 1 : 0) - gate) * ease(on ? 30 : 3.5, dt);
      return gate;
    },
    get open() {
      return on;
    },
    get value() {
      return gate;
    },
  };
}
