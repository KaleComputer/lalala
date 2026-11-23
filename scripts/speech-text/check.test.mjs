// Streaming sentence-splitting regression guard (23 Nov 2026):
// Prevents LONG_FRAGMENT from chopping the last word off a finished streaming sentence
// ("...and Modal " + "budget." / "...to Eggnut " + "Lead.") or stranding a one-word tail.
// Run: node --experimental-strip-types --test scripts/speech-text/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { takeSentences } from "../../src/voice/speechText.ts";

test("finished long sentence while still streaming is emitted whole (no split inside 'Modal budget.' or 'Eggnut Lead.')", () => {
  const modal =
    "On it—sending the onboarding overhaul and ten German voices to Eggnut Lead, and telling the local AI lead to launch three parallel Neon xhigh moonshot researchers across STT, LLM, and TTS with weight-space steering and Modal budget.";
  const r1 = takeSentences(modal, false);
  assert.deepEqual(r1.sentences, [modal]);
  assert.equal(r1.consumed, modal.length);
  assert.deepEqual(takeSentences(modal.slice(r1.consumed), true), { sentences: [], consumed: 0 });

  const eggnut =
    "On it—checking why modal budget has a gap in speech, replacing the old Squishies v1 card with a live Squishy Configurator with color and brightness sliders, and sending your tap-to-walk onboarding and target-follow camera to Eggnut Lead.";
  const r2 = takeSentences(eggnut, false);
  assert.deepEqual(r2.sentences, [eggnut]);
  assert.equal(r2.consumed, eggnut.length);
});

test("unfinished streaming run-on prefers a clause break over the last space and never strands a one-word tail", () => {
  const partial =
    "On it—checking why modal budget has a gap in speech, replacing the old Squishies v1 card with a live Squishy Configurator with color and brightness sliders, and sending your tap-to-walk onboarding and target-follow camera to Eggnut ";
  const r = takeSentences(partial, false);
  assert.equal(r.sentences.length, 1);
  assert.ok(r.sentences[0].endsWith("sliders, "), `expected clause cut, got: ${JSON.stringify(r.sentences[0])}`);
  const rest = partial.slice(r.consumed) + "Lead.";
  const rFinal = takeSentences(rest, true);
  assert.deepEqual(rFinal.sentences, [
    "and sending your tap-to-walk onboarding and target-follow camera to Eggnut Lead.",
  ]);
});

test("comma-less streaming run-on keeps a multi-word tail instead of cutting right before the last word", () => {
  const partial =
    "We are running three parallel moonshot experiments across speech recognition and language modeling and voice synthesis with weight space steering across all our local models and checking the remaining cloud compute and Modal ";
  assert.ok(partial.length > 220);
  const full = partial + "budget.";
  const r = takeSentences(partial, false);
  assert.equal(r.sentences.length, 1);
  assert.ok(!r.sentences[0].trimEnd().endsWith("Modal"), `cut right before final word: ${JSON.stringify(r.sentences[0])}`);
  const tail = full.slice(r.consumed);
  assert.ok(tail.includes("Modal budget."), `expected 'Modal budget.' intact in tail, got: ${JSON.stringify(tail)}`);
  assert.ok(tail.trim().split(/\s+/).length >= 3, `tail too short: ${JSON.stringify(tail)}`);
});

test("streaming decimal or abbreviation at end of long fragment is not treated as a finished sentence", () => {
  const longDecimal =
    "We checked all the speech synthesis benchmarks across ten voices and verified the latency numbers and memory footprint on every phone and desktop build running the latest release candidate and bumped the threshold all the way to 3.";
  assert.ok(longDecimal.length > 220);
  const r = takeSentences(longDecimal, false);
  assert.ok(r.consumed < longDecimal.length);
  assert.ok(!r.sentences.at(-1)?.endsWith("3."), `should not flush trailing '3.' while streaming: ${JSON.stringify(r.sentences)}`);
});
