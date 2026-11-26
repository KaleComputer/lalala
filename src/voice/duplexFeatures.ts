/**
 * Audio frontend and strictly causal 12.5 Hz (80 ms/frame) prosodic feature extractor for Kale's
 * standalone full-duplex turn-policy ONNX model (`p2b_standalone_d160_sup`).
 *
 * Pure TypeScript (zero dependencies) with exact mathematical parity to `duplex_features.py`:
 *   - 80-bin Slaney log-mel spectrogram (512-pt FFT, 160-sample / 10 ms hop, 0.97 preemphasis,
 *     400-sample Povey window centered in 512, per-feature CMVN) -> `[80, T_mel]`.
 *   - 12-dim causal prosody per 80 ms frame (1280 samples): log-RMS, delta log-RMS, relative
 *     log-RMS vs causal running peak, ZCR, spectral centroid, spectral flatness, spectral rolloff
 *     (85%), 3 spectral band energy ratios (80-260, 260-650, 1800-5500 Hz), normalized F0, and
 *     autocorrelation voicing strength -> `[T_enc, 12]`.
 *   - Plus an acoustic trailing filled-pause ("uhm"/"uh") detector that spots sustained, steady
 *     voiced vowel/nasal holds right before trailing silence (recovering UMAI end-gap fillers
 *     even when streaming STT omits them).
 */

export const DUPLEX_SAMPLE_RATE = 16_000;
export const DUPLEX_HOP_MEL = 160; // 10 ms
export const DUPLEX_ENC_SUBSAMPLE = 8; // 8x subsampling -> 80 ms
export const DUPLEX_FRAME_SAMPLES = DUPLEX_HOP_MEL * DUPLEX_ENC_SUBSAMPLE; // 1280 samples
export const DUPLEX_N_MELS = 80;
export const DUPLEX_PROSODY_DIM = 12;

const MEL_N_FFT = 512;
const MEL_BINS = MEL_N_FFT / 2 + 1; // 257
const PROS_N_FFT = 1024;
const PROS_BINS = PROS_N_FFT / 2 + 1; // 513
const AC_N_FFT = 2048;

type FftPlan = {
  readonly n: number;
  readonly rev: Uint32Array;
  readonly cos: Float32Array;
  readonly sin: Float32Array;
};

function makeFftPlan(n: number): FftPlan {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const half = n >> 1;
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let k = 0; k < half; k += 1) {
    const angle = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  return { n, rev, cos, sin };
}

/** In-place iterative radix-2 Cooley-Tukey complex FFT (inverse = true divides by N). */
function fftInPlace(plan: FftPlan, re: Float32Array, im: Float32Array, inverse = false): void {
  const { n, rev, cos, sin } = plan;
  for (let i = 0; i < n; i += 1) {
    const j = rev[i]!;
    if (j > i) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const tw = k * step;
        const wr = cos[tw]!;
        const wi = sign * sin[tw]!;
        const even = start + k;
        const odd = even + half;
        const or = re[odd]!;
        const oi = im[odd]!;
        const tr = wr * or - wi * oi;
        const ti = wr * oi + wi * or;
        re[odd] = re[even]! - tr;
        im[odd] = im[even]! - ti;
        re[even] = re[even]! + tr;
        im[even] = im[even]! + ti;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! * inv;
      im[i] = im[i]! * inv;
    }
  }
}

const FFT_512 = makeFftPlan(MEL_N_FFT);
const FFT_1024 = makeFftPlan(PROS_N_FFT);
const FFT_2048 = makeFftPlan(AC_N_FFT);

/** Slaney mel filterbank `[DUPLEX_N_MELS * MEL_BINS]` matching `duplex_features._slaney_mel_fb`. */
function buildSlaneyMelFilterbank(): Float32Array {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  const hzToMel = (f: number) =>
    f >= minLogHz ? minLogMel + Math.log(Math.max(f, 1e-9) / minLogHz) / logStep : f / fSp;
  const melToHz = (m: number) =>
    m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fSp * m;

  const melMin = hzToMel(0);
  const melMax = hzToMel(DUPLEX_SAMPLE_RATE / 2);
  const freqs = new Float64Array(DUPLEX_N_MELS + 2);
  for (let i = 0; i < DUPLEX_N_MELS + 2; i += 1) {
    freqs[i] = melToHz(melMin + ((melMax - melMin) * i) / (DUPLEX_N_MELS + 1));
  }
  const fftFreqs = new Float64Array(MEL_BINS);
  for (let b = 0; b < MEL_BINS; b += 1) {
    fftFreqs[b] = ((DUPLEX_SAMPLE_RATE / 2) * b) / (MEL_BINS - 1);
  }
  const fb = new Float32Array(DUPLEX_N_MELS * MEL_BINS);
  for (let m = 0; m < DUPLEX_N_MELS; m += 1) {
    const left = freqs[m]!;
    const center = freqs[m + 1]!;
    const right = freqs[m + 2]!;
    if (right <= left) continue;
    const norm = 2 / Math.max(1e-6, right - left);
    const dLeft = Math.max(1e-6, center - left);
    const dRight = Math.max(1e-6, right - center);
    const row = m * MEL_BINS;
    for (let b = 0; b < MEL_BINS; b += 1) {
      const f = fftFreqs[b]!;
      const w = Math.max(0, Math.min((f - left) / dLeft, (right - f) / dRight));
      fb[row + b] = w * norm;
    }
  }
  return fb;
}

/** Povey window of length 400 zero-padded into 512 (`[56..455]`) matching `duplex_features._POVEY512`. */
function buildPovey512(): Float32Array {
  const win = new Float32Array(MEL_N_FFT);
  // np.hanning(401)[:-1] -> 0.5 - 0.5 * cos(2*pi*i / 400) for i in 0..399
  for (let i = 0; i < 400; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 400);
    win[56 + i] = Math.pow(Math.max(hann, 0), 0.85);
  }
  return win;
}

/** Hann window of length 1024 matching `np.hanning(1024)`. */
function buildHann1024(): Float32Array {
  const win = new Float32Array(PROS_N_FFT);
  for (let i = 0; i < PROS_N_FFT; i += 1) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (PROS_N_FFT - 1));
  }
  return win;
}

const MEL_FB = buildSlaneyMelFilterbank();
const POVEY_512 = buildPovey512();
const HANN_1024 = buildHann1024();
const PROS_FREQS = (() => {
  const f = new Float32Array(PROS_BINS);
  for (let b = 0; b < PROS_BINS; b += 1) f[b] = ((DUPLEX_SAMPLE_RATE / 2) * b) / (PROS_BINS - 1);
  return f;
})();

// Precompute sparse non-zero bin ranges for each mel filter to speed up matrix-vector multiply.
const MEL_RANGES: ReadonlyArray<{ readonly start: number; readonly end: number }> = (() => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let m = 0; m < DUPLEX_N_MELS; m += 1) {
    const row = m * MEL_BINS;
    let start = MEL_BINS;
    let end = 0;
    for (let b = 0; b < MEL_BINS; b += 1) {
      if (MEL_FB[row + b]! > 0) {
        if (b < start) start = b;
        if (b + 1 > end) end = b + 1;
      }
    }
    ranges.push({ start: start < end ? start : 0, end });
  }
  return ranges;
})();

/**
 * Exact NeMo FastConformer 80-mel Povey 8 kHz features with per-feature CMVN.
 * Returns flat row-major `[80, frames]` Float32Array and frame count `frames`.
 * When `targetFrames` is provided (e.g. `encFrames * 8` for the standalone ONNX graph whose 8x
 * conv stem requires `ceil(T_mel / 8) === T_enc`), returns the right-aligned trailing `targetFrames`
 * frames (zero-padded on the left if shorter) with per-feature CMVN over that exact window.
 */
export function computeNemoMel(
  wav: Float32Array,
  targetFrames?: number,
): {
  readonly mel: Float32Array<ArrayBuffer>;
  readonly frames: number;
} {
  const rawLen = Math.max(wav.length, 1600);
  // Preemphasis + 256-sample zero padding on both ends.
  const padded = new Float32Array(rawLen + 512);
  if (wav.length > 0) {
    padded[256] = wav[0]!;
    for (let i = 1; i < wav.length; i += 1) {
      padded[256 + i] = wav[i]! - 0.97 * wav[i - 1]!;
    }
    if (rawLen > wav.length) {
      padded[256 + wav.length] = -0.97 * wav[wav.length - 1]!;
    }
  }

  const rawFrames = Math.max(1, 1 + Math.floor((padded.length - MEL_N_FFT) / DUPLEX_HOP_MEL));
  const frames = targetFrames !== undefined && targetFrames > 0 ? targetFrames : rawFrames;
  const srcOffset = rawFrames > frames ? rawFrames - frames : 0;
  const dstOffset = frames > rawFrames ? frames - rawFrames : 0;
  const copyCount = Math.min(rawFrames, frames);

  const mel = new Float32Array(DUPLEX_N_MELS * frames);
  const re = new Float32Array(MEL_N_FFT);
  const im = new Float32Array(MEL_N_FFT);
  const pwr = new Float32Array(MEL_BINS);
  const minLog = Math.log(1e-10);
  if (dstOffset > 0) mel.fill(minLog);

  for (let iFrame = 0; iFrame < copyCount; iFrame += 1) {
    const tSrc = srcOffset + iFrame;
    const tDst = dstOffset + iFrame;
    const offset = tSrc * DUPLEX_HOP_MEL;
    for (let i = 0; i < MEL_N_FFT; i += 1) {
      re[i] = padded[offset + i]! * POVEY_512[i]!;
      im[i] = 0;
    }
    fftInPlace(FFT_512, re, im, false);
    for (let b = 0; b < MEL_BINS; b += 1) {
      const r = re[b]!;
      const k = im[b]!;
      pwr[b] = r * r + k * k;
    }
    for (let m = 0; m < DUPLEX_N_MELS; m += 1) {
      const range = MEL_RANGES[m]!;
      const row = m * MEL_BINS;
      let acc = 0;
      for (let b = range.start; b < range.end; b += 1) {
        acc += pwr[b]! * MEL_FB[row + b]!;
      }
      mel[m * frames + tDst] = Math.log(acc > 1e-10 ? acc : 1e-10);
    }
  }

  // Per-feature (per mel bin) CMVN across time frames.
  for (let m = 0; m < DUPLEX_N_MELS; m += 1) {
    const base = m * frames;
    let sum = 0;
    for (let t = 0; t < frames; t += 1) sum += mel[base + t]!;
    const mean = sum / frames;
    let sq = 0;
    for (let t = 0; t < frames; t += 1) {
      const d = mel[base + t]! - mean;
      sq += d * d;
    }
    const invStd = 1 / Math.sqrt(sq / frames + 1e-5);
    for (let t = 0; t < frames; t += 1) {
      mel[base + t] = (mel[base + t]! - mean) * invStd;
    }
  }

  return { mel, frames };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Extracts strictly causal 12-dim 12.5 Hz (80 ms/frame) prosodic features `[encFrames, 12]`.
 * Matches `duplex_features.extract_causal_prosody`.
 */
export function extractCausalProsody(
  wav: Float32Array,
  encFrames: number,
): Float32Array<ArrayBuffer> {
  const T = Math.max(1, Math.floor(encFrames));
  const out = new Float32Array(T * DUPLEX_PROSODY_DIM);
  const eps = 1e-10;

  const re1024 = new Float32Array(PROS_N_FFT);
  const im1024 = new Float32Array(PROS_N_FFT);
  const pwr1024 = new Float32Array(PROS_BINS);
  const re2048 = new Float32Array(AC_N_FFT);
  const im2048 = new Float32Array(AC_N_FFT);

  let prevLogRms = 0;
  let runMaxLogRms = -5;

  for (let t = 0; t < T; t += 1) {
    const base = t * DUPLEX_FRAME_SAMPLES;

    // 0-3: RMS, delta, causal relative RMS, zero-crossing rate.
    let energy = 0;
    let zc = 0;
    let prevSign = 0;
    for (let i = 0; i < DUPLEX_FRAME_SAMPLES; i += 1) {
      const idx = base + i;
      const s = idx < wav.length ? wav[idx]! : 0;
      energy += s * s;
      const sign = s >= 0 ? 1 : 0;
      if (i > 0 && sign !== prevSign) zc += 1;
      prevSign = sign;
    }
    const rms = Math.sqrt(energy / DUPLEX_FRAME_SAMPLES + eps);
    const logRms = clamp(Math.log10(rms + 1e-6), -5, 0);
    const fLogRms = (logRms + 2.5) / 2.5;
    const fDelta = t > 0 ? clamp((logRms - prevLogRms) * 1.5, -2, 2) : 0;
    prevLogRms = logRms;
    if (t === 0 || logRms > runMaxLogRms) runMaxLogRms = logRms;
    const fRel = clamp((logRms - runMaxLogRms) / 2, -2.5, 0);
    const fZcr = (zc / (DUPLEX_FRAME_SAMPLES - 1)) * 4;

    // 4-9: Spectral features from center 1024 samples [128..1151].
    let segMean = 0;
    for (let i = 0; i < PROS_N_FFT; i += 1) {
      const idx = base + 128 + i;
      const s = (idx < wav.length ? wav[idx]! : 0) * HANN_1024[i]!;
      re1024[i] = s;
      im1024[i] = 0;
      segMean += s;
    }
    segMean /= PROS_N_FFT;

    // Save zero-mean windowed segment into 2048-pt FFT buffer before FFT mutates re1024.
    for (let i = 0; i < PROS_N_FFT; i += 1) {
      re2048[i] = re1024[i]! - segMean;
      im2048[i] = 0;
    }
    for (let i = PROS_N_FFT; i < AC_N_FFT; i += 1) {
      re2048[i] = 0;
      im2048[i] = 0;
    }

    fftInPlace(FFT_1024, re1024, im1024, false);
    let totP = eps;
    let centNum = 0;
    let logSum = 0;
    let lowSum = 0;
    let kidSum = 0;
    let hiSum = 0;
    for (let b = 0; b < PROS_BINS; b += 1) {
      const r = re1024[b]!;
      const k = im1024[b]!;
      const p = r * r + k * k + eps;
      pwr1024[b] = p;
      totP += p;
      const freq = PROS_FREQS[b]!;
      centNum += p * freq;
      logSum += Math.log(p);
      if (freq >= 80 && freq < 260) lowSum += p;
      else if (freq >= 260 && freq < 650) kidSum += p;
      else if (freq >= 1800 && freq < 5500) hiSum += p;
    }
    const fCent = clamp(centNum / totP / 4000, 0, 2);
    const geo = Math.exp(logSum / PROS_BINS);
    const arith = (totP - eps) / PROS_BINS + eps;
    const fFlat = clamp(geo / arith, 0, 1);

    const rollTarget = 0.85 * totP;
    let cum = 0;
    let rollIdx = 0;
    for (let b = 0; b < PROS_BINS; b += 1) {
      cum += pwr1024[b]!;
      if (cum >= rollTarget) {
        rollIdx = b;
        break;
      }
    }
    const fRoll = clamp(PROS_FREQS[rollIdx]! / 6000, 0, 1.5);
    const fLow = clamp((lowSum / totP) * 3, 0, 3);
    const fKid = clamp((kidSum / totP) * 3, 0, 3);
    const fHi = clamp((hiSum / totP) * 3, 0, 3);

    // 10-11: FFT autocorrelation pitch proxy in [70..550 Hz] (lags 29..229).
    fftInPlace(FFT_2048, re2048, im2048, false);
    for (let i = 0; i < AC_N_FFT; i += 1) {
      const r = re2048[i]!;
      const k = im2048[i]!;
      re2048[i] = r * r + k * k;
      im2048[i] = 0;
    }
    fftInPlace(FFT_2048, re2048, im2048, true);
    const ac0 = Math.max(re2048[0]!, 1e-8);
    let bestVal = -Infinity;
    let bestLag = 29;
    for (let lag = 29; lag < 230; lag += 1) {
      const v = re2048[lag]! / ac0;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    const voicing = clamp(bestVal, 0, 1);
    const f0Hz = voicing > 0.25 && rms > 0.004 ? DUPLEX_SAMPLE_RATE / bestLag : 0;
    const fF0 = f0Hz > 0 ? clamp((f0Hz - 70) / 480, 0, 1) : 0;
    const fVoic = rms > 0.004 ? voicing : 0;

    const row = t * DUPLEX_PROSODY_DIM;
    out[row] = Number.isFinite(fLogRms) ? fLogRms : 0;
    out[row + 1] = Number.isFinite(fDelta) ? fDelta : 0;
    out[row + 2] = Number.isFinite(fRel) ? fRel : 0;
    out[row + 3] = Number.isFinite(fZcr) ? fZcr : 0;
    out[row + 4] = Number.isFinite(fCent) ? fCent : 0;
    out[row + 5] = Number.isFinite(fFlat) ? fFlat : 0;
    out[row + 6] = Number.isFinite(fRoll) ? fRoll : 0;
    out[row + 7] = Number.isFinite(fLow) ? fLow : 0;
    out[row + 8] = Number.isFinite(fKid) ? fKid : 0;
    out[row + 9] = Number.isFinite(fHi) ? fHi : 0;
    out[row + 10] = Number.isFinite(fF0) ? fF0 : 0;
    out[row + 11] = Number.isFinite(fVoic) ? fVoic : 0;
  }

  return out;
}

/**
 * UMAI acoustic end-gap filled-pause cue: inspects the last voiced syllable before trailing quiet
 * in the causal prosody sequence. Filled pauses ("uhm", "uh", "mm") exhibit a sustained, quasi-steady
 * low-flatness, low-ZCR voiced vowel/nasal plateau (>= 240 ms / 3 consecutive 80 ms frames) with
 * gentle loudness envelope and concentrated low-mid harmonic energy right at the trailing edge of
 * active speech.
 */
export function detectAcousticFilledPause(prosody: Float32Array, encFrames: number): boolean {
  const T = Math.min(encFrames, Math.floor(prosody.length / DUPLEX_PROSODY_DIM));
  if (T < 5) return false;

  // Locate the last active voiced frame within the trailing 1.6 s (20 frames).
  let lastActive = -1;
  const searchStart = Math.max(0, T - 20);
  for (let t = T - 1; t >= searchStart; t -= 1) {
    const base = t * DUPLEX_PROSODY_DIM;
    const fLogRms = prosody[base]!;
    const fVoic = prosody[base + 11]!;
    if (fLogRms > -0.25 && fVoic > 0.35) {
      lastActive = t;
      break;
    }
  }
  if (lastActive < 2) return false;

  // Count consecutive steady vowel/nasal filled-pause frames ending at `lastActive`.
  let run = 0;
  let f0Min = Infinity;
  let f0Max = -Infinity;
  for (let t = lastActive; t >= Math.max(0, lastActive - 7); t -= 1) {
    const base = t * DUPLEX_PROSODY_DIM;
    const fLogRms = prosody[base]!;
    const fDelta = Math.abs(prosody[base + 1]!);
    const fZcr = prosody[base + 3]!;
    const fCent = prosody[base + 4]!;
    const fFlat = prosody[base + 5]!;
    const fF0 = prosody[base + 10]!;
    const fVoic = prosody[base + 11]!;

    const steadyVoicedVowel =
      fLogRms > -0.25 &&
      fVoic >= 0.42 &&
      fFlat <= 0.18 &&
      fZcr <= 0.65 &&
      fCent <= 0.45 &&
      fDelta <= 0.35;
    if (!steadyVoicedVowel) break;
    run += 1;
    if (fF0 > 0) {
      if (fF0 < f0Min) f0Min = fF0;
      if (fF0 > f0Max) f0Max = fF0;
    }
  }

  // At least 3 consecutive 80 ms frames (240 ms) of steady-pitch vowel/nasal hold.
  const pitchSteady = f0Min === Infinity || f0Max - f0Min <= 0.14;
  return run >= 3 && pitchSteady;
}
