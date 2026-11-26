// Duplex turn-policy ONNX + UMAI ("uhm") filled-pause hold-the-floor unit & smoke tests.
// Run: node --experimental-strip-types --no-warnings --test scripts/duplex-turn/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { test } from "node:test";

import {
  DUPLEX_FRAME_SAMPLES,
  DUPLEX_N_MELS,
  DUPLEX_PROSODY_DIM,
  DUPLEX_SAMPLE_RATE,
  computeNemoMel,
  detectAcousticFilledPause,
  extractCausalProsody,
} from "../../src/voice/duplexFeatures.ts";
import {
  DUPLEX_STALE_MS,
  applyDuplexDecision,
  detectUmaiHesitation,
  evaluateDuplexPolicy,
  safeEvaluateDuplexPolicy,
} from "../../src/voice/duplexTurn.ts";
import { parseSynced } from "../../src/voice/settingsStore.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");
const MODEL_DIR = NodePath.join(ROOT, "public/models/duplex-turn-policy");
const MODEL_PATH = NodePath.join(MODEL_DIR, "model.int8.onnx");
const META_PATH = NodePath.join(MODEL_DIR, "meta.json");

function makeInference(logits, state, opts = {}) {
  const decided = applyDuplexDecision(logits, state);
  return {
    action: decided.action,
    probs: decided.probs,
    logits: decided.logits,
    state,
    at: opts.at ?? 10_000,
    acousticFiller: opts.acousticFiller ?? false,
  };
}

test("1. labs.duplexTurnPolicy defaults strictly OFF and parses strictly as boolean", () => {
  assert.equal(parseSynced({})?.labs.duplexTurnPolicy, false);
  assert.equal(parseSynced({ labs: {} })?.labs.duplexTurnPolicy, false);
  assert.equal(parseSynced({ labs: { duplexTurnPolicy: "yes" } })?.labs.duplexTurnPolicy, false);
  assert.equal(parseSynced({ labs: { duplexTurnPolicy: 1 } })?.labs.duplexTurnPolicy, false);
  assert.equal(parseSynced({ labs: { duplexTurnPolicy: true } })?.labs.duplexTurnPolicy, true);
  assert.equal(parseSynced({ labs: { duplexTurnPolicy: false } })?.labs.duplexTurnPolicy, false);
});

test("1b. when OFF, evaluateDuplexPolicy is a strict no-op passthrough regardless of inference or fillers", () => {
  const infIdle = makeInference([5, -2, -2, -2], 0, { acousticFiller: true });
  const idle = evaluateDuplexPolicy({
    enabled: false,
    inference: infIdle,
    now: 10_100,
    baseWaitMs: 2_600,
    baseRule: "open",
    partial: "I think uhm",
    hasRealWords: true,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -25,
    floorDb: -55,
  });
  assert.equal(idle.active, false);
  assert.equal(idle.suppressStart, false);
  assert.equal(idle.suppressHold, false);
  assert.equal(idle.triggerHold, false);
  assert.equal(idle.effectiveWaitMs, 2_600);
  assert.equal(idle.rule, "open");
  assert.equal(idle.umai.detected, false);

  const infBarge = makeInference([-2, -2, 6, -2], 1);
  const barge = evaluateDuplexPolicy({
    enabled: false,
    inference: infBarge,
    now: 10_100,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "Wait stop",
    hasRealWords: true,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -20,
    floorDb: -55,
  });
  assert.equal(barge.active, false);
  assert.equal(barge.triggerHold, false);
  assert.equal(barge.suppressHold, false);
});

test("2a. applyDuplexDecision enforces legal-state masking across idle (0) and playback (1)", () => {
  // In idle (state=0), pause_playback (idx 2) is masked out even if its raw logit is highest.
  const idle = applyDuplexDecision([0.1, 0.2, 9.5, 1.5], 0);
  assert.equal(idle.action, "answer_now");
  assert.equal(idle.probs[2], 0);

  // During playback (state=1), answer_now (idx 3) is masked out even if its raw logit is highest.
  const playing = applyDuplexDecision([0.1, 0.2, 1.5, 9.5], 1);
  assert.equal(playing.action, "pause_playback");
  assert.equal(playing.probs[3], 0);
});

test("2b. ignore_background never blocks adult speech starts or playback barge-in holds", () => {
  // Regression (26 Nov): the kids-trained standalone head scores adult voices and pre-speech
  // silence as ignore_background (0.96–1.00). It must never veto close-talk gate starts or
  // adult barge-in holds in lalala.
  const idleOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([4.5, -1.0, -1.0, -1.5], 0),
    now: 10_200,
    baseWaitMs: 2_600,
    baseRule: "no-words-yet",
    partial: "",
    hasRealWords: false,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -19,
    floorDb: -74,
  });
  assert.equal(idleOut.active, true);
  assert.equal(idleOut.suppressStart, false);

  const playOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([4.5, -1.0, -1.5, -1.0], 1),
    now: 10_200,
    baseWaitMs: 2_600,
    baseRule: "open",
    partial: "",
    hasRealWords: false,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -18,
    floorDb: -74,
  });
  assert.equal(playOut.suppressHold, false);
  assert.equal(playOut.triggerHold, false);
});

test("2c. keep_listening + UMAI 'uhm' filled-pause add-on extends floor hold and ignores 'uh-huh'", () => {
  // Lexical UMAI filled pause detection
  assert.equal(detectUmaiHesitation("So I want to, uhm...", false).detected, true);
  assert.equal(detectUmaiHesitation("Let's check um", false).source, "lexical");
  assert.equal(detectUmaiHesitation("Wait uh,", false).detected, true);
  assert.equal(detectUmaiHesitation("I think [um]", false).detected, true);
  // UMAI §3.1: "uh huh" / "uh-huh" is a backchannel, never a filled-pause hold!
  assert.equal(detectUmaiHesitation("uh-huh", false).detected, false);
  assert.equal(detectUmaiHesitation("yeah uh huh.", true).detected, false);
  // Acoustic fallback catches omitted fillers on open utterances, not closed sentences.
  assert.equal(detectUmaiHesitation("And then we should", true).source, "acoustic");
  assert.equal(detectUmaiHesitation("That sounds great.", true).detected, false);

  // Combined duplex keep_listening + UMAI "uhm" extends silence budget cleanly.
  const holdOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-1.0, 3.2, -1.0, -0.5], 0, { acousticFiller: true }),
    now: 10_200,
    baseWaitMs: 2_000,
    baseRule: "open",
    partial: "I want to build, uhm...",
    hasRealWords: true,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -48,
    floorDb: -52,
  });
  assert.equal(holdOut.umai.detected, true);
  assert.equal(holdOut.umai.source, "both");
  assert.ok(holdOut.effectiveWaitMs >= 3_800, `expected extended wait, got ${holdOut.effectiveWaitMs}`);
  assert.equal(holdOut.rule, "duplex+umai-both");

  // Even if the ONNX model says answer_now, an explicit UMAI "uhm" protects the speaker from cutoff!
  const umaiProtects = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-2.0, -1.0, -2.0, 4.0], 0),
    now: 10_200,
    baseWaitMs: 2_000,
    baseRule: "open",
    partial: "Open the, uhm",
    hasRealWords: true,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -49,
    floorDb: -52,
  });
  assert.ok(umaiProtects.effectiveWaitMs > 2_000);
  assert.equal(umaiProtects.rule, "umai-lexical");

  // During playback, keep_listening (backchannel "okay"/"mhm") suppresses false barge-in.
  const backchannelOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-1.0, 3.5, -1.5, -1.0], 1),
    now: 10_200,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "mhm",
    hasRealWords: true,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -30,
    floorDb: -52,
  });
  assert.equal(backchannelOut.suppressHold, true);
  assert.equal(backchannelOut.triggerHold, false);
});

test("2d. pause_playback barges in during TTS playback when mic is over room floor", () => {
  const bargeOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-2.0, -1.5, 4.2, -1.0], 1),
    now: 10_200,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "",
    hasRealWords: false,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -24,
    floorDb: -52,
  });
  assert.equal(bargeOut.triggerHold, true);
  assert.equal(bargeOut.suppressHold, false);

  // Stale inference (> DUPLEX_STALE_MS) falls back cleanly and does not trigger hold.
  const staleOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-2.0, -1.5, 4.2, -1.0], 1, { at: 1_000 }),
    now: 1_000 + DUPLEX_STALE_MS + 100,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "",
    hasRealWords: false,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -24,
    floorDb: -52,
  });
  assert.equal(staleOut.triggerHold, false);
});

test("2e. answer_now commits turn faster on real finished speech (without UMAI hesitation)", () => {
  const commitOut = evaluateDuplexPolicy({
    enabled: true,
    inference: makeInference([-2.0, -1.2, -2.0, 4.5], 0),
    now: 10_200,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "Check the weather in Berlin.",
    hasRealWords: true,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -51,
    floorDb: -52,
  });
  assert.equal(commitOut.rule, "duplex-answer-now");
  assert.equal(commitOut.effectiveWaitMs, 1_050);
  assert.equal(commitOut.umai.detected, false);
});

test("3. duplexFeatures mel + 12-dim causal prosody + acoustic filled-pause smoke check", () => {
  // 2.56 s (32 frames @ 80 ms) synthetic voiced vowel ("uhm" ~160 Hz + harmonics) followed by 0.48 s silence.
  const encFrames = 32;
  const nSamples = encFrames * DUPLEX_FRAME_SAMPLES;
  const wav = new Float32Array(nSamples);
  const voiceEnd = 26 * DUPLEX_FRAME_SAMPLES;
  for (let i = 0; i < voiceEnd; i += 1) {
    const t = i / DUPLEX_SAMPLE_RATE;
    wav[i] =
      0.18 * Math.sin(2 * Math.PI * 160 * t) +
      0.11 * Math.sin(2 * Math.PI * 320 * t) +
      0.06 * Math.sin(2 * Math.PI * 480 * t);
  }

  const { mel, frames } = computeNemoMel(wav, encFrames * 8);
  assert.equal(frames, encFrames * 8);
  assert.equal(mel.length, DUPLEX_N_MELS * frames);
  for (let i = 0; i < mel.length; i += 1) {
    assert.ok(Number.isFinite(mel[i]), `non-finite mel at ${i}`);
  }

  const pros = extractCausalProsody(wav, encFrames);
  assert.equal(pros.length, encFrames * DUPLEX_PROSODY_DIM);
  for (let i = 0; i < pros.length; i += 1) {
    assert.ok(Number.isFinite(pros[i]), `non-finite pros at ${i}`);
  }
  // Sustained steady vowel before trailing silence triggers the acoustic filled-pause cue.
  assert.equal(detectAcousticFilledPause(pros, encFrames), true);

  // Pure silence must never trigger acoustic filled-pause.
  const silentPros = extractCausalProsody(new Float32Array(nSamples), encFrames);
  assert.equal(detectAcousticFilledPause(silentPros, encFrames), false);
});

test("4. ONNX bundle asset and metadata exist and match standalone input/output contract", () => {
  assert.ok(NodeFS.existsSync(MODEL_PATH), "missing public/models/duplex-turn-policy/model.int8.onnx");
  assert.ok(NodeFS.existsSync(META_PATH), "missing public/models/duplex-turn-policy/meta.json");
  const stat = NodeFS.statSync(MODEL_PATH);
  assert.ok(stat.size > 1_000_000 && stat.size < 3_000_000, `unexpected ONNX size: ${stat.size}`);

  const meta = JSON.parse(NodeFS.readFileSync(META_PATH, "utf8"));
  assert.equal(meta.tag, "p2b_standalone_d160_sup");
  assert.deepEqual(meta.inputs, ["mel", "pros", "state"]);
  assert.deepEqual(meta.outputs, ["logits"]);
  assert.deepEqual(meta.classes, [
    "ignore_background",
    "keep_listening",
    "pause_playback",
    "answer_now",
  ]);

  // Verify the binary ONNX protobuf contains the expected graph input/output tensor names.
  const raw = NodeFS.readFileSync(MODEL_PATH);
  for (const name of ["mel", "pros", "state", "logits"]) {
    assert.ok(raw.includes(Buffer.from(name, "ascii")), `ONNX graph missing tensor name "${name}"`);
  }
});

test("5. fail-open: failed worker, null/corrupted inference, or thrown errors fall back to plain Silero VAD", () => {
  // 5a. Worker load/runtime failure (`failed: true`) returns exact plain-VAD passthrough.
  const failedOut = evaluateDuplexPolicy({
    enabled: true,
    failed: true,
    inference: makeInference([-1.0, 3.5, -1.5, -1.0], 1, { acousticFiller: true }),
    now: 10_200,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "So I want to, uhm...",
    hasRealWords: true,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -24,
    floorDb: -60,
  });
  assert.equal(failedOut.active, false);
  assert.equal(failedOut.suppressStart, false);
  assert.equal(failedOut.suppressHold, false);
  assert.equal(failedOut.triggerHold, false);
  assert.equal(failedOut.effectiveWaitMs, 1_500);
  assert.equal(failedOut.rule, "sentence");
  assert.equal(failedOut.umai.detected, false);

  // 5b. Null inference while worker is still loading or unavailable never blocks speech or alters wait.
  const nullOut = evaluateDuplexPolicy({
    enabled: true,
    inference: null,
    now: 10_200,
    baseWaitMs: 2_600,
    baseRule: "open",
    partial: "Check the logs",
    hasRealWords: true,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -50,
    floorDb: -54,
  });
  assert.equal(nullOut.suppressStart, false);
  assert.equal(nullOut.suppressHold, false);
  assert.equal(nullOut.triggerHold, false);
  assert.equal(nullOut.effectiveWaitMs, 2_600);
  assert.equal(nullOut.rule, "open");

  // 5c. Non-finite logits and corrupted inference probabilities fail open safely without NaN.
  const nanDecision = applyDuplexDecision([Number.NaN, Number.POSITIVE_INFINITY, -1, 0], 0);
  for (const p of nanDecision.probs) assert.ok(Number.isFinite(p), `expected finite prob, got ${p}`);
  const corruptOut = evaluateDuplexPolicy({
    enabled: true,
    inference: {
      action: "keep_listening",
      probs: [Number.NaN, 1, 0, 0],
      logits: [0, 0, 0, 0],
      state: 1,
      at: 10_100,
      acousticFiller: true,
    },
    now: 10_200,
    baseWaitMs: 1_500,
    baseRule: "sentence",
    partial: "Hello",
    hasRealWords: true,
    replyAudible: true,
    playerSpeaking: true,
    playerHolding: false,
    inSpeech: false,
    turnVoiced: false,
    micDb: -22,
    floorDb: -60,
  });
  assert.equal(corruptOut.suppressHold, false);
  assert.equal(corruptOut.triggerHold, false);

  // 5d. safeEvaluateDuplexPolicy catches any unexpected runtime throw and falls back to plain VAD.
  let caught = null;
  const throwingInput = {
    enabled: true,
    inference: null,
    now: 10_200,
    baseWaitMs: 2_600,
    baseRule: "open",
    get partial() {
      throw new Error("boom");
    },
    hasRealWords: false,
    replyAudible: false,
    playerSpeaking: false,
    playerHolding: false,
    inSpeech: true,
    turnVoiced: true,
    micDb: -30,
    floorDb: -60,
  };
  const safeOut = safeEvaluateDuplexPolicy(throwingInput, (err) => {
    caught = err;
  });
  assert.ok(caught instanceof Error && caught.message === "boom");
  assert.equal(safeOut.active, false);
  assert.equal(safeOut.suppressStart, false);
  assert.equal(safeOut.suppressHold, false);
  assert.equal(safeOut.triggerHold, false);
  assert.equal(safeOut.effectiveWaitMs, 2_600);
  assert.equal(safeOut.rule, "open");
});
