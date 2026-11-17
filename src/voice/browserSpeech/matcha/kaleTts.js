// Kale's own small text-to-speech, no espeak: text -> words (dizione's text rules, ../dizione) -> IPA (a
// CMUdict-derived word list, hand-checked overrides, dizione's homograph picker and a 0.9M-weight GRU
// for unknown words) -> token ids -> Matcha-TTS (ONNX, mel) -> Vocos (ONNX, magnitude and phase) ->
// inverse STFT -> 22,050 Hz PCM. Copied from Kale's browser demo (kale-tts.js) as an ES module; `ort`
// is onnxruntime-web, passed in. Kale's voices (../kaleVoice.worker.ts) use its front end alone
// (normalizer, G2p): text -> IPA.
/* eslint-disable */
import { Normalizer, spokenText } from "../dizione/spoken.js";
import { covers, pronounce } from "../dizione/homographs.js";

// ------------------------------------------------------------------------------------------------ text -> words
/**
 * Numbers, money, dates, times, units, codes and abbreviations as words (dizione's rules). `lex` decides
 * which letter runs are words; letters to name come out in capitals ("A M", "T three"), which the G2p spells.
 */
function normalizer(lex) {
  const rules = new Normalizer((word) => lex.has(word));
  const spell = (letters) => {
    const upper = letters.toUpperCase();
    return upper.length <= 5 && !(upper.length >= 3 && lex.has(letters.toLowerCase())) ? upper : [...upper].join(" ");
  };
  // The sentence splitter cuts after "Dr.", leaving it last, where dizione cannot tell it from "drive".
  return (text) => spokenText(sizeSuffixes(text).replace(/\bDr\.(?=\s*$)/, "Doctor"), rules, spell);
}

/** The comma that closes a list ("speed, melody, clear words, and how it sounds") is dropped: read aloud it sounds like a
 *  break in the list. Decided by structure only: the comma sits right before "and"/"or", and the same clause (back to the
 *  last ; : or the sentence start) already has an earlier comma with only short items (1-2 words) between the commas.
 *  A lone clause comma ("we finished the work, and then we went home") has no earlier comma and stays. */
function dropListComma(s) {
  return s.replace(/,(\s+(?:and|or)\s)/gi, (m, tail, at) => {
    const clause = s.slice(0, at).split(/[;:]/).pop();
    const parts = clause.split(",");
    if (parts.length < 2) return m;
    const items = parts.slice(1).map((p) => p.trim().split(/\s+/).filter(Boolean).length);
    return items.every((n) => n >= 1 && n <= 2) ? tail : m;
  });
}

/** Size suffixes on numbers, as in model sizes: an uppercase M, B or K right after the digits is a word ("Kokoro-82M" ->
 *  "Kokoro-82 million", "7.5M" -> "7.5 million", "3B" -> "3 billion", "5K" -> "5 thousand"). Structure only: digits, then
 *  the one uppercase letter, then no letter or digit (so "MB", "GB", "KB" stay units and lowercase "5m" / "3km" are untouched). */
function sizeSuffixes(text) {
  const word = { M: "million", B: "billion", K: "thousand" };
  return text.replace(/(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)([MBK])(?![\p{L}\p{N}])/gu, (m, n, s) => `${n} ${word[s]}`);
}

/** Sentences, each one model call (as the app and the bench render). */
function sentences(text, normalize) {
  const out = [];
  for (const part of normalize(text).split(/(?<=[.!?…])\s+|\n+/)) {
    const s = dropListComma(part.trim());
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ words -> IPA
const TOKEN = /[A-Za-z]+(?:['’][A-Za-z]+)*|[.,!?;:…—–]/g;
const PUNCT = { ".": ".", ",": ",", "!": "!", "?": "?", ";": ";", ":": ":", "…": "…", "—": ",", "–": "," };
const VOWELS = new Set("aeiouɑɐɒæɔəɘɚɛɜɝɞɨɪʊʌɤøœɶɯɵʉʏᵻ");
const SIBILANT = ["s", "z", "ʃ", "ʒ", "tʃ", "dʒ"];
const VOICELESS = ["p", "t", "k", "f", "θ"];
const SUFFIXES = [["ly", "li"], ["ness", "nəs"], ["ful", "fəl"], ["less", "ləs"], ["er", "ɚ"], ["est", "ɪst"], ["ment", "mənt"]];
const LETTER_SOUND = { a: "æ", b: "b", c: "k", d: "d", e: "ɛ", f: "f", g: "ɡ", h: "h", i: "ɪ", j: "dʒ", k: "k", l: "l", m: "m",
  n: "n", o: "ɑː", p: "p", q: "k", r: "ɹ", s: "s", t: "t", u: "ʌ", v: "v", w: "w", x: "ks", y: "j", z: "z" };
const FOLD = { "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ø": "o", "Ø": "O", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D",
  "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i", "ʻ": "", "ʼ": "", "‘": "'", "`": "'" };
const MAX_LEARNT = 4096;

function fold(text) {
  let out = "";
  for (const ch of text.normalize("NFD")) {
    if (/\p{Mn}/u.test(ch)) continue;
    out += ch in FOLD ? FOLD[ch] : ch;
  }
  return out.normalize("NFC");
}
const norm = (t) => t.replace(/’/g, "'");
const unstress = (ipa) => ipa.replace(/[ˈˌ]/g, "");
const secondary = (ipa) => ipa.replace(/ˈ/g, "ˌ");
const VOWEL = /eɪ|aɪ|aʊ|ɔɪ|oʊ|əʊ|ɑː|iː|uː|ɜː|ɔː|oː|[aeiouæɑɒɔəɚɛɜɪʊʌᵻɐ]/g;
const vowelCount = (ipa) => (ipa.match(VOWEL) || []).length;
const bare = (ipa) => ipa.replace(/[ˈˌː]/g, "");
function editDistance(x, y) {
  const d = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= y.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] !== y[j - 1] ? 1 : 0)); prev = t; }
  }
  return d[y.length];
}
function firstSound(ipa) {
  for (const ch of ipa) if (ch !== "ˈ" && ch !== "ˌ") return ch;
  return null;
}
function stressFirstVowel(ipa) {
  const plain = unstress(ipa);
  const at = [...plain].findIndex((c) => VOWELS.has(c));
  if (at < 0) return plain;
  const cs = [...plain];
  return cs.slice(0, at).join("") + "ˈ" + cs.slice(at).join("");
}
const pluralSuffix = (ipa) => (SIBILANT.some((s) => ipa.endsWith(s)) ? "ᵻz" : VOICELESS.some((s) => ipa.endsWith(s)) ? "s" : "z");
function pastSuffix(ipa) {
  if (ipa.endsWith("t") || ipa.endsWith("d")) return "ᵻd";
  if (VOICELESS.concat(["s", "ʃ", "tʃ"]).some((s) => ipa.endsWith(s))) return "t";
  return "d";
}

function readTable(text, into) {
  const out = into || new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab > 0) out.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return out;
}

class G2pModel {
  constructor(buf) {
    const dv = new DataView(buf);
    let o = 0;
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    o = 4;
    if (magic !== "KG2P") throw new Error("not a g2p model");
    const version = i32();
    if (version !== 1) throw new Error("g2p model version " + version);
    const e = i32(), h = i32(), d = i32(), nIn = i32(), nOut = i32(), maxOut = i32();
    const inputs = Array.from({ length: nIn }, i32);
    const outputs = Array.from({ length: nOut }, i32);
    const take = (n) => { const a = new Float64Array(n); for (let k = 0; k < n; k++) { a[k] = half(dv.getUint16(o, true)); o += 2; } return a; };
    const gru = (cols, size) => ({ wIh: take(3 * size * cols), wHh: take(3 * size * size), bIh: take(3 * size), bHh: take(3 * size) });
    this.w = {
      embIn: take(nIn * e), encFwd: gru(e, h), encBwd: gru(e, h), initW: take(d * 2 * h), initB: take(d),
      embOut: take(nOut * e), dec: gru(e + 2 * h, d), attW: take(2 * h * d), combW: take(d * (d + 2 * h)), combB: take(d),
      outW: take(nOut * d), outB: take(nOut),
    };
    if (o !== buf.byteLength) throw new Error("g2p model size");
    this.e = e; this.h = h; this.d = d; this.maxOut = maxOut; this.outputs = outputs;
    this.inIndex = new Map();
    for (let i = 1; i < nIn; i++) this.inIndex.set(inputs[i], i);
  }

  phonemes(word) {
    if (!word || word.length > 24) return null;
    const { e, h, d, w } = this;
    const ids = [];
    for (const ch of word) { const id = this.inIndex.get(ch.codePointAt(0)); if (id === undefined) return null; ids.push(id); }
    const n = ids.length;
    const emb = (table, id) => table.subarray(id * e, id * e + e);
    const fwd = [], bwd = [];
    let hf = new Float64Array(h);
    for (let t = 0; t < n; t++) { hf = gruCell(w.encFwd, emb(w.embIn, ids[t]), hf, h); fwd[t] = hf; }
    let hb = new Float64Array(h);
    for (let t = n - 1; t >= 0; t--) { hb = gruCell(w.encBwd, emb(w.embIn, ids[t]), hb, h); bwd[t] = hb; }
    const enc = fwd.map((f, t) => cat(f, bwd[t]));
    let state = matVec(w.initW, cat(hf, hb), d, w.initB).map(Math.tanh);
    let ctx = new Float64Array(2 * h);
    let prev = 1; // BOS
    let out = "";
    const limit = Math.min(this.maxOut, 3 * n + 6);
    let ended = false;
    for (let step = 0; step < limit; step++) {
      state = gruCell(w.dec, cat(emb(w.embOut, prev), ctx), state, d);
      const q = matVec(w.attW, state, 2 * h, null);
      const scores = enc.map((v) => dot(v, q));
      const top = Math.max(...scores);
      let total = 0;
      for (let t = 0; t < n; t++) { scores[t] = Math.exp(scores[t] - top); total += scores[t]; }
      ctx = new Float64Array(2 * h);
      for (let k = 0; k < 2 * h; k++) { let s = 0; for (let t = 0; t < n; t++) s += scores[t] * enc[t][k]; ctx[k] = s / total; }
      const hid = matVec(w.combW, cat(state, ctx), d, w.combB).map(Math.tanh);
      const logits = matVec(w.outW, hid, this.outputs.length, w.outB);
      let best = 0;
      for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
      if (best === 2) { ended = true; break; } // EOS
      if (best < 3) return null;
      out += String.fromCodePoint(this.outputs[best]);
      prev = best;
    }
    if (!ended) return null;
    return [...out].some((c) => VOWELS.has(c)) ? out : null;
  }
}

function half(v) {
  const sign = v & 0x8000 ? -1 : 1, ex = (v >> 10) & 0x1f, m = v & 0x3ff;
  if (ex === 0) return Math.fround(sign * m * Math.pow(2, -24));
  if (ex === 0x1f) return m === 0 ? sign * Infinity : NaN;
  return Math.fround(sign * (1 + m / 1024) * Math.pow(2, ex - 15));
}
function cat(a, b) { const o = new Float64Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function row(m, k, x, bias) { let s = bias; const base = k * x.length; for (let i = 0; i < x.length; i++) s += m[base + i] * x[i]; return s; }
function matVec(m, x, rows, b) { const o = new Float64Array(rows); for (let k = 0; k < rows; k++) o[k] = row(m, k, x, b ? b[k] : 0); return o; }
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function gruCell(g, x, hPrev, size) {
  const out = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const r = sigmoid(row(g.wIh, k, x, g.bIh[k]) + row(g.wHh, k, hPrev, g.bHh[k]));
    const z = sigmoid(row(g.wIh, size + k, x, g.bIh[size + k]) + row(g.wHh, size + k, hPrev, g.bHh[size + k]));
    const c = Math.tanh(row(g.wIh, 2 * size + k, x, g.bIh[2 * size + k]) + r * row(g.wHh, 2 * size + k, hPrev, g.bHh[2 * size + k]));
    out[k] = (1 - z) * c + z * hPrev[k];
  }
  return out;
}

class G2p {
  constructor(lex, model) { this.lex = lex; this.model = model || null; this.learnt = new Map(); }

  phonemes(sentence) {
    const tokens = fold(sentence).match(TOKEN) || [];
    const out = [];
    let skip = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const mark = PUNCT[tok];
      if (mark !== undefined) { if (out.length) out[out.length - 1] += mark; continue; }
      if (skip) { skip = false; continue; }
      const nx = tokens[i + 1];
      const next = nx !== undefined && !(nx in PUNCT) ? nx : null;
      if (next !== null) {
        const pair = this.lex.get(norm(tok).toLowerCase() + " " + norm(next).toLowerCase());
        if (pair !== undefined) { out.push(pair); skip = true; continue; }
      }
      const reading = this.homograph(tok, tokens, i);
      if (reading !== null) { out.push(reading); continue; }
      const ipa = this.word(tok, next);
      if (ipa) out.push(ipa);
    }
    return out.join(" ");
  }

  /**
   * A homograph as its sentence means it ("read" past or present). The word list's own pronunciation stays
   * when it is already the reading meant (closest to it of the readings); dizione's when another one is.
   */
  homograph(token, tokens, index) {
    const w = norm(token), low = w.toLowerCase();
    if (!covers(low) || (w.length > 1 && w === w.toUpperCase())) return null;
    const { sense, senses, plural } = pronounce(low, tokens.map(norm), index);
    const own = this.lex.get(plural ? low.slice(0, -1) : low);
    let ipa = sense;
    if (own !== undefined) {
      const nearest = senses.reduce((best, s) => (distance(s, own) < distance(best, own) ? s : best));
      if (nearest === sense) ipa = own;
    }
    return plural ? ipa + pluralSuffix(ipa) : ipa;
  }

  word(token, next) {
    const lex = this.lex;
    const w = norm(token), low = w.toLowerCase();
    if (w.length > 1 && w === w.toUpperCase()) {
      if (lex.has(w)) return lex.get(w);
      if (!(w.length >= 3 && lex.has(low)) && w.length <= 5) return this.spell(w);
    }
    if (next !== null) {
      const following = this.lookup(norm(next).toLowerCase(), null);
      const variant = lex.get(low + "#v");
      if (following != null && variant !== undefined) { const f = firstSound(following); if (f !== null && VOWELS.has(f)) return variant; }
    }
    return this.lookup(low, w);
  }

  lookup(low, original) {
    const lex = this.lex;
    if (lex.has(low)) return lex.get(low);
    if (original === null) return null;
    for (const [cands, suffix] of this.stems(low)) {
      for (const stem of cands) { const base = lex.get(stem); if (base) return base + suffix(base); }
    }
    if (low.length === 1) return lex.has(low) ? lex.get(low) : LETTER_SOUND[low] ?? "";
    const said = this.fallback(low);
    if (said != null) return this.joined(low, said) ?? said;
    for (let i = 3; i < low.length - 2; i++) {
      const a = lex.get(low.slice(0, i)), b = lex.get(low.slice(i));
      if (a !== undefined && b !== undefined) return a + secondary(b);
    }
    return this.chunks(low);
  }

  /**
   * A guessed word of 6+ letters that is two listed words (3+ letters each, the first such split) read as the guess plus one
   * stray vowel ("barcode" guessed as "barcodey"): the two words instead. Any other difference keeps the guess, which reads
   * prefixes, -able words and names better than a split (17 Nov, 40,000-word sweep: 9 changes, none worse).
   */
  joined(low, said) {
    if (low.length < 6) return null;
    for (let i = 3; i <= low.length - 3; i++) {
      const a = this.lex.get(low.slice(0, i)), b = this.lex.get(low.slice(i));
      if (a === undefined || b === undefined) continue;
      const two = a + secondary(b);
      return vowelCount(said) > vowelCount(two) && editDistance(bare(said), bare(two)) <= 1 ? two : null;
    }
    return null;
  }

  fallback(low) {
    if (!this.model) return null;
    if (this.learnt.has(low)) return this.learnt.get(low);
    const said = this.model.phonemes(low);
    if (this.learnt.size >= MAX_LEARNT) this.learnt.clear();
    this.learnt.set(low, said);
    return said;
  }

  stems(w) {
    const out = [];
    const doubled = (b) => (b.length > 2 && b[b.length - 1] === b[b.length - 2] ? [b.slice(0, -1)] : []);
    if (w.endsWith("'s")) out.push([[w.slice(0, -2)], pluralSuffix]);
    if (w.endsWith("s'")) out.push([[w.slice(0, -1)], () => ""]);
    if (w.endsWith("ies") && w.length > 4) out.push([[w.slice(0, -3) + "y"], pluralSuffix]);
    if (w.endsWith("es") && w.length > 3) out.push([[w.slice(0, -2)], pluralSuffix]);
    if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) out.push([[w.slice(0, -1)], pluralSuffix]);
    if (w.endsWith("ied") && w.length > 4) out.push([[w.slice(0, -3) + "y"], pastSuffix]);
    if (w.endsWith("ed") && w.length > 4) { const b = w.slice(0, -2); out.push([[b, b + "e", ...doubled(b)], pastSuffix]); }
    if (w.endsWith("ing") && w.length > 5) { const b = w.slice(0, -3); out.push([[b, b + "e", ...doubled(b)], () => "ɪŋ"]); }
    for (const [suf, sound] of SUFFIXES) {
      if (w.endsWith(suf) && w.length > suf.length + 2) {
        const b = w.slice(0, -suf.length);
        out.push([[b, ...(b.endsWith("i") ? [b.slice(0, -1) + "y"] : []), ...doubled(b)], () => sound]);
      }
    }
    return out;
  }

  spell(word) {
    // The letter A is "ay"; the word list's "a" is the article ("uh"), which made VAD "vee-uh-dee".
    const parts = [...word].map((ch) => { const c = ch.toLowerCase(); return c === "a" ? "ˈeɪ" : this.lex.get(c) ?? LETTER_SOUND[c] ?? ""; }).filter((p) => p);
    if (!parts.length) return "";
    return parts.slice(0, -1).map(secondary).join("") + parts[parts.length - 1];
  }

  chunks(w) {
    let out = "", i = 0;
    while (i < w.length) {
      let matched = false;
      for (let j = w.length; j > i + 2; j--) {
        const piece = this.lex.get(w.slice(i, j));
        if (piece) { out += unstress(piece); i = j; matched = true; break; }
      }
      if (!matched) { out += LETTER_SOUND[w[i]] ?? ""; i++; }
    }
    return stressFirstVowel(out);
  }
}

function distance(a, b) {
  const x = [...a], y = [...b];
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length];
}

// ------------------------------------------------------------------------------------------------ IPA -> ids
function readTokens(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const at = line.lastIndexOf(" ");
    if (at < 0) continue;
    map.set(line.slice(0, at), parseInt(line.slice(at + 1), 10));
  }
  return map;
}
/** One id per IPA codepoint (unknown ones dropped), a blank (0) before, between and after (Matcha's add_blank). */
function toIds(ipa, tokens) {
  const ids = [0];
  for (const ch of ipa) { const id = tokens.get(ch); if (id !== undefined) ids.push(id, 0); }
  return ids;
}

// ------------------------------------------------------------------------------------------------ inverse STFT
function makeFFT(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  // in-place inverse complex FFT (no 1/n), radix 2
  return function ifft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step]; // +i for the inverse
          const a = s + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

/** torch.istft(center=True, periodic Hann, normalized=False) of mag * (x + i y), shapes [bins, frames]. */
function istft(mag, x, y, frames, nFft, hop) {
  const bins = nFft / 2 + 1;
  const win = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  const total = nFft + hop * (frames - 1);
  const out = new Float64Array(total), env = new Float64Array(total);
  const ifft = makeFFT(nFft);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < bins; k++) {
      const m = mag[k * frames + t];
      re[k] = m * x[k * frames + t];
      im[k] = m * y[k * frames + t];
    }
    im[0] = 0; im[bins - 1] = 0; // irfft ignores the imaginary part of DC and Nyquist
    for (let k = 1; k < bins - 1; k++) { re[nFft - k] = re[k]; im[nFft - k] = -im[k]; }
    ifft(re, im);
    const off = t * hop;
    for (let i = 0; i < nFft; i++) { out[off + i] += (re[i] / nFft) * win[i]; env[off + i] += win[i] * win[i]; }
  }
  const start = nFft / 2, len = hop * (frames - 1);
  const pcm = new Float32Array(len);
  for (let i = 0; i < len; i++) { const e = env[start + i]; pcm[i] = e > 1e-11 ? out[start + i] / e : 0; }
  return pcm;
}

// ------------------------------------------------------------------------------------------------ the voice
class Voice {
  /**
   * files: { model, vocoder, g2pModel: ArrayBuffer|Uint8Array; tokens, lexicon, override: string }
   * opts: { sessionOptions } passed to ort.InferenceSession.create
   */
  static async load(ort, files, opts = {}) {
    const v = new Voice();
    v.ort = ort;
    const so = opts.sessionOptions || {};
    v.acoustic = await ort.InferenceSession.create(asBytes(files.model), so);
    v.vocoder = await ort.InferenceSession.create(asBytes(files.vocoder), so);
    v.tokens = readTokens(files.tokens);
    const lex = readTable(files.lexicon);
    if (files.override) readTable(files.override, lex);
    const g2pBuf = files.g2pModel ? asBytes(files.g2pModel) : null;
    v.g2p = new G2p(lex, g2pBuf ? new G2pModel(g2pBuf.buffer.slice(g2pBuf.byteOffset, g2pBuf.byteOffset + g2pBuf.byteLength)) : null);
    v.normalize = normalizer(lex);
    v.sampleRate = 22050; v.nFft = 1024; v.hop = 256;
    return v;
  }

  /** One sentence -> { pcm, ipa, ids, ms: {acoustic, vocoder} } */
  async speakSentence(sentence, { lengthScale = 1.0, noiseScale = 0.667 } = {}) {
    const ort = this.ort;
    const ipa = this.g2p.phonemes(sentence);
    if (!ipa.trim()) return { pcm: new Float32Array(0), ipa, ids: [], ms: { acoustic: 0, vocoder: 0 } };
    const ids = toIds(ipa, this.tokens);
    const t0 = now();
    const r = await this.acoustic.run({
      x: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      x_length: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      noise_scale: new ort.Tensor("float32", Float32Array.from([noiseScale]), [1]),
      length_scale: new ort.Tensor("float32", Float32Array.from([lengthScale]), [1]),
    });
    const mel = r.mel;
    const t1 = now();
    const vr = await this.vocoder.run({ mels: mel });
    const frames = vr.mag.dims[2];
    const pcm = istft(vr.mag.data, vr.x.data, vr.y.data, frames, this.nFft, this.hop);
    const t2 = now();
    return { pcm, ipa, ids, ms: { acoustic: t1 - t0, vocoder: t2 - t1 } };
  }

  /** Text -> { pcm, parts }, sentences joined with gapMs of silence. */
  async speak(text, opts = {}) {
    const gap = new Float32Array(Math.round(((opts.gapMs ?? 120) / 1000) * this.sampleRate));
    const parts = [];
    for (const s of sentences(text, this.normalize)) parts.push({ text: s, ...(await this.speakSentence(s, opts)) });
    const chunks = [];
    parts.forEach((p, i) => { if (i) chunks.push(gap); chunks.push(p.pcm); });
    const len = chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Float32Array(len);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    return { pcm, parts };
  }
}

function asBytes(b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }
function now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

/** 16-bit PCM WAV bytes. */
function wav(pcm, sampleRate = 22050) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Uint8Array(buf);
}

export { Voice, G2p, G2pModel, normalizer, readTable, readTokens, toIds, istft, sentences, fold, wav };
