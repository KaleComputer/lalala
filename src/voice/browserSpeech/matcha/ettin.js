// Ettin word features' inputs for kale-tts-1-tiny (the Ettin text side), with no dependencies, for Node, browsers and embedded JS engines.
// 1. EttinTokenizer: the byte-level BPE of jhu-clsp/ettin-encoder-17m (MIT; its tokenizer.json ships next to the model): NFC, GPT-2
//    pre-tokenizer, byte-level BPE, its added tokens (space runs etc.) matched first, [CLS] ... [SEP], character offsets exactly as
//    Hugging Face tokenizers reports them (checked on 197 texts).
// 2. ettinInputs(tok, text, prev): the graph's ettin_ids / ettin_mask / wavg for one sentence. The previous sentence is Ettin's left
//    context; wavg [W, S] averages each word's sub-tokens (W = text.split(/\s+/) words), as the training code did.
// 3. wordIndex(sentenceIds, wordIds, nWords): the graph's widx (one word index per sound id): per-word ids joined with the space id must
//    equal the sentence ids, else a proportional spread (the training code's fallback).

const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice(); let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Array(256); bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); }); return m;
}
const B2U = bytesToUnicode();
function utf8(str) {   // UTF-8 bytes (no TextEncoder: embedded engines like QuickJS don't have it)
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export class EttinTokenizer {
  /** json: the parsed tokenizer.json */
  constructor(json) {
    const m = json.model;
    this.vocab = m.vocab;
    this.ranks = new Map((m.merges ?? []).map((x, i) => [Array.isArray(x) ? x.join(" ") : x, i]));
    const added = Object.fromEntries((json.added_tokens ?? []).map((t) => [t.content, t.id]));
    this.cls = added["[CLS]"] ?? this.vocab["[CLS]"]; this.sep = added["[SEP]"] ?? this.vocab["[SEP]"];
    const plain = (json.added_tokens ?? []).filter((t) => !t.special).map((t) => t.content).sort((a, b) => b.length - a.length);
    this.added = new Map((json.added_tokens ?? []).filter((t) => !t.special).map((t) => [t.content, t.id]));
    this.addedRe = plain.length ? new RegExp(plain.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu") : null;
    this.cache = new Map();
  }

  _bpe(word) {   // word: byte-level unicode string -> list of sub-token strings
    const hit = this.cache.get(word); if (hit) return hit;
    let parts = [...word];
    while (parts.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i] + " " + parts[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
    if (this.cache.size < 50000) this.cache.set(word, parts);
    return parts;
  }

  /** text -> { ids, offsets: [[start, end), ...] in code points of the NFC text, [0,0] for [CLS] / [SEP] } */
  encode(text) {
    const t = text.normalize("NFC"), cps = Array.from(t);
    const cpAtUnit = []; { let u = 0; cps.forEach((c, i) => { for (let k = 0; k < c.length; k++) cpAtUnit[u + k] = i; u += c.length; }); cpAtUnit[t.length] = cps.length; }
    const ids = [this.cls], offsets = [[0, 0]];
    const plain = (seg, segStart) => {                           // pre-tokenizer + byte-level BPE on a stretch with no added token
      for (const mt of seg.matchAll(GPT2_SPLIT)) {
        const piece = mt[0], startCp = cpAtUnit[segStart + mt.index];
        const pcs = Array.from(piece), byteCp = [];             // code point index (within piece) of every byte
        pcs.forEach((c, i) => { for (const _ of utf8(c)) byteCp.push(i); });
        const word = utf8(piece).map((b) => B2U[b]).join("");
        let at = 0;
        for (const sub of this._bpe(word)) {
          const n = [...sub].length, id = this.vocab[sub], a = byteCp[at], b = byteCp[at + n - 1] + 1; at += n;
          if (id !== undefined) { ids.push(id); offsets.push([startCp + a, startCp + b]); }
        }
      }
    };
    let last = 0;
    if (this.addedRe) for (const mt of t.matchAll(this.addedRe)) {
      if (mt.index > last) plain(t.slice(last, mt.index), last);
      ids.push(this.added.get(mt[0])); offsets.push([cpAtUnit[mt.index], cpAtUnit[mt.index + mt[0].length]]); last = mt.index + mt[0].length;
    }
    if (last < t.length) plain(t.slice(last), last);
    ids.push(this.sep); offsets.push([0, 0]);
    return { ids, offsets };
  }
}

/** -> { ettin_ids: number[], ettin_mask: number[], wavg: Float32Array (W x S, row-major), W, S } */
export function ettinInputs(tok, text, prev = "") {
  const words = text.split(/\s+/).filter(Boolean), pre = prev && prev.trim() ? prev.trim() + " " : "";
  const full = pre + words.join(" "), { ids, offsets } = tok.encode(full);
  const S = ids.length, W = Math.max(words.length, 1), wavg = new Float32Array(W * S);
  let pos = Array.from(pre).length;
  words.forEach((w, i) => {
    const a = pos, b = pos + Array.from(w).length; pos = b + 1;
    const idx = []; offsets.forEach(([s, e], k) => { if (e > s && s < b && e > a) idx.push(k); });
    for (const k of idx) wavg[i * S + k] = 1 / Math.max(1, idx.length);
  });
  return { ettin_ids: ids, ettin_mask: ids.map(() => 1), wavg, W, S };
}

/** sentence ids (no pads), per-word ids (each word through the same g2p), word count -> widx (one word index per sentence id) */
export function wordIndex(sentIds, wordIds, nWords, spaceId = 16) {
  const joined = []; wordIds.forEach((p, i) => { joined.push(...p); if (i < wordIds.length - 1) joined.push(spaceId); });
  if (joined.length === sentIds.length && joined.every((x, i) => x === sentIds[i])) {
    const w = []; wordIds.forEach((p, i) => { for (const _ of p) w.push(i); if (i < wordIds.length - 1) w.push(i); }); return w;
  }
  const nw = Math.max(1, sentIds.filter((x) => x === spaceId).length + 1); let k = 0; const w = [];
  for (const x of sentIds) { w.push(Math.min(Math.max(nWords, 1) - 1, Math.floor(k * nWords / nw))); if (x === spaceId) k++; }
  return w;
}
