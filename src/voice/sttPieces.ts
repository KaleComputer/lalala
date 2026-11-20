/**
 * Parakeet in the browser keeps the memory of the longest audio it was ever given (199 MB at 2 s,
 * 606 MB at 70 s, 1.3 GB at 186 s: a phone's tab dies), so no transcription gets more than 20 s.
 * A longer utterance is cut into pieces in the quietest pause 15–20 s into each. Where there is no
 * clean pause (one word running into the next), the pieces overlap by 1.5 s instead and are stitched
 * at the run of words both heard there, so a word across the cut comes out whole and once.
 */
const RATE = 16_000;
export const PIECE_MAX = 20 * RATE;
const SEARCH_FROM = 15 * RATE;
export const OVERLAP = 1.5 * RATE;
const FRAME = 160; // 10 ms
// A pause this long and this quiet is between words: closures inside a word are shorter.
const GAP_FRAMES = 20;
// Parakeet's times for one word in two pieces differ by up to ~0.4 s (measured 20 Nov), so the
// words heard in an overlap are looked for this far either side of it, and at most this many.
const DRIFT_S = 0.8;
const NEAR = 8;

export type Word = { readonly text: string; readonly start: number; readonly end: number };
/** What Parakeet heard in a piece; `words` (seconds from the piece's start) when it gave them. */
export type Heard = { readonly text: string; readonly words: ReadonlyArray<Word> | null };
export type Cut = { readonly end: number; readonly next: number };

/**
 * Where the piece starting at `start` ends (`end`) and the next begins (`next`), for audio that runs
 * past 20 s of it: in its quietest clean pause 15–20 s in, else at 20 s overlapping the next by 1.5 s.
 * `sample(i)` is sample i of the utterance, -1..1.
 */
export function cutPiece(sample: (i: number) => number, start: number): Cut {
  const frames = Math.floor(PIECE_MAX / FRAME);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const s = sample(start + f * FRAME + i);
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / FRAME);
  }
  const sorted = Float32Array.from(rms).sort();
  // The quietest 200 ms of the 20 s, and his voice.
  const floor = sorted[Math.floor(frames * 0.01)]!;
  const level = sorted[Math.floor(frames * 0.9)]!;
  const quiet = floor + 0.1 * (level - floor);
  const overlap = { end: start + PIECE_MAX, next: start + PIECE_MAX - OVERLAP };
  // Even the quietest stretch is a fifth of his voice: no pause can be told from a dip in a word.
  if (quiet > level * 0.2) return overlap;
  let best: { from: number; length: number; loudness: number } | null = null;
  let from = -1;
  let sum = 0;
  for (let f = SEARCH_FROM / FRAME; f <= frames; f += 1) {
    if (f < frames && rms[f]! < quiet) {
      if (from < 0) {
        from = f;
        sum = 0;
      }
      sum += rms[f]!;
      continue;
    }
    if (from >= 0) {
      const length = f - from;
      const loudness = sum / length;
      if (length >= GAP_FRAMES && (best === null || length > best.length || (length === best.length && loudness < best.loudness)))
        best = { from, length, loudness };
      from = -1;
    }
  }
  if (best === null) return overlap;
  const at = start + (best.from + Math.floor(best.length / 2)) * FRAME;
  return { end: at, next: at };
}

const norm = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** One transcript of all the pieces, in order: `starts[i]` and `ends[i]` are piece i's samples. */
export function joinPieces(
  heard: ReadonlyArray<Heard>,
  starts: ReadonlyArray<number>,
  ends: ReadonlyArray<number>,
): string {
  let joined: Word[] = [];
  heard.forEach((piece, i) => {
    const offset = starts[i]! / RATE;
    // Without word times (the computer's server) its words are placed nowhere: NaN.
    const words: Word[] = piece.words?.length
      ? piece.words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }))
      : piece.text.split(/\s+/).filter(Boolean).map((text) => ({ text, start: NaN, end: NaN }));
    const overlaps = i > 0 && starts[i]! < ends[i - 1]!;
    joined = overlaps ? stitch(joined, words, offset, ends[i - 1]! / RATE) : [...joined, ...words];
  });
  return joined.map((word) => word.text).join(" ");
}

/**
 * Two transcripts overlapping from `from` to `to` (seconds), joined at the longest run of words
 * both heard there: the first's words before it, then the second's from it on. A word cut off at
 * either piece's edge sits outside the run and goes with it; the other piece heard it whole.
 */
function stitch(a: Word[], b: Word[], from: number, to: number): Word[] {
  let tailFrom = a.length;
  while (tailFrom > 0 && a.length - tailFrom < NEAR && !(a[tailFrom - 1]!.end < from - DRIFT_S)) tailFrom -= 1;
  let headTo = 0;
  while (headTo < b.length && headTo < NEAR && !(b[headTo]!.start > to + DRIFT_S)) headTo += 1;
  const tail = a.slice(tailFrom).map((word) => norm(word.text));
  const head = b.slice(0, headTo).map((word) => norm(word.text));
  let best = { length: 0, i: 0, j: 0 };
  let previous = new Array<number>(head.length + 1).fill(0);
  for (let i = 1; i <= tail.length; i += 1) {
    const row = new Array<number>(head.length + 1).fill(0);
    for (let j = 1; j <= head.length; j += 1) {
      if (tail[i - 1] === "" || tail[i - 1] !== head[j - 1]) continue;
      row[j] = previous[j - 1]! + 1;
      if (row[j]! > best.length) best = { length: row[j]!, i, j };
    }
    previous = row;
  }
  // One shared word is a weak match ("the … the"), unless it is a long one.
  if (best.length > 1 || (best.length === 1 && tail[best.i - 1]!.length > 3))
    return [...a.slice(0, tailFrom + best.i - best.length), ...b.slice(best.j - best.length)];
  // Nothing heard in both (a quiet overlap): split at its middle by the times, where there are any.
  const middle = (from + to) / 2;
  const mid = (word: Word) => (word.start + word.end) / 2;
  if (a.some((word) => !Number.isNaN(word.start)))
    return [...a.filter((word) => !(mid(word) >= middle)), ...b.filter((word) => !(mid(word) < middle))];
  return [...a, ...b];
}
