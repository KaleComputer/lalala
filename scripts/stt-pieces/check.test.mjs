// Long utterances reach Parakeet in pieces of at most 20 s (src/voice/sttPieces.ts): its memory keeps
// the longest audio it was ever given, and 70 s of it took 606 MB. Tim (20 Nov): "what will happen if
// at second 20 I start the word, then we cut it in half, and then it continues on second 21?"
// Run: node --experimental-strip-types --test scripts/stt-pieces/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { OVERLAP, PIECE_MAX, cutPiece, joinPieces } from "../../src/voice/sttPieces.ts";

const RATE = 16_000;
/** Speech-like sound (a 200 Hz buzz, loud) except in `pauses` ([from, to] seconds), with a little room noise. */
const audio = (seconds, pauses = []) => {
  const pcm = new Float32Array(seconds * RATE);
  let seed = 1;
  for (let i = 0; i < pcm.length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const noise = (seed / 2147483647 - 0.5) * 0.004;
    const t = i / RATE;
    const quiet = pauses.some(([from, to]) => t >= from && t < to);
    pcm[i] = noise + (quiet ? 0 : 0.3 * Math.sin(2 * Math.PI * 200 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)));
  }
  return (i) => pcm[i] ?? 0;
};
const word = (text, start, end) => ({ text, start, end });

test("a piece ends in the quietest clean pause 15–20 s in, never at a fixed 20 s", () => {
  const cut = cutPiece(audio(25, [[12, 13], [16.1, 16.25], [17.4, 17.8]]), 0);
  assert.equal(cut.end, cut.next);
  assert.ok(cut.end / RATE > 17.4 && cut.end / RATE < 17.8, `cut at ${cut.end / RATE} s`);
  // Pieces after the first are searched from their own start.
  const later = cutPiece(audio(45, [[17.6, 18], [35.2, 35.6]]), 17.8 * RATE);
  assert.ok(later.end / RATE > 35.2 && later.end / RATE < 35.6, `cut at ${later.end / RATE} s`);
});

test("a closure inside a word (under 200 ms) is no pause: no clean gap means overlapping pieces", () => {
  const cut = cutPiece(audio(25, [[16, 16.08], [19.9, 20.05]]), 0);
  assert.deepEqual(cut, { end: PIECE_MAX, next: PIECE_MAX - OVERLAP });
});

const OVERLAPPING = [[0, PIECE_MAX - OVERLAP], [PIECE_MAX, 29 * RATE]];

test("Tim's case: a word from 19.8 s to 20.6 s comes out whole and once", () => {
  // What Parakeet 110M heard (20 Nov) in speech with no pause, "transcription" spoken from 19.8 s:
  // the first piece (0–20 s) drops its cut-off start, the second (18.5 s on) hears the cut-off
  // "finally" as "Today", and its times for the same words run up to 0.4 s later.
  const first = {
    text: "and going and finally we talk about the",
    words: [word("and", 17.52, 17.68), word("going", 17.68, 17.84), word("and", 18, 18.16), word("finally", 18.16, 18.4), word("we", 18.64, 18.8), word("talk", 18.8, 18.96), word("about", 19.04, 19.2), word("the", 19.2, 19.28)],
  };
  const second = {
    text: "Today we talk about the transcription of every single word.",
    words: [word("Today", 0.08, 0.32), word("we", 0.48, 0.56), word("talk", 0.72, 0.88), word("about", 0.88, 0.96), word("the", 1.12, 1.28), word("transcription", 1.52, 2.08), word("of", 2.32, 2.48), word("every", 2.5, 2.7), word("single", 2.7, 3), word("word.", 3, 3.3)],
  };
  const expected = "and going and finally we talk about the transcription of every single word.";
  assert.equal(joinPieces([first, second], ...OVERLAPPING), expected);
  // The computer's server gives no word times: the same stitch by the words alone.
  const untimed = [first, second].map(({ text }) => ({ text, words: null }));
  assert.equal(joinPieces(untimed, ...OVERLAPPING), expected);
});

test("a word cut off at either edge comes from the piece that heard it whole", () => {
  const first = { text: "right before the overlap begins okay tra", words: null };
  const second = { text: "lap begins okay transcription so", words: null };
  assert.equal(joinPieces([first, second], ...OVERLAPPING), "right before the overlap begins okay transcription so");
});

test("pieces cut in a pause join as they are, in order", () => {
  const heard = [
    { text: "one two", words: null },
    { text: "three", words: null },
    { text: "four", words: null },
  ];
  assert.equal(joinPieces(heard, [0, 17 * RATE, 35 * RATE], [17 * RATE, 35 * RATE, 40 * RATE]), "one two three four");
});
