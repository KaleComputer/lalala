/**
 * Full-duplex 4-action turn policy + UMAI ("uhm") filled-pause floor-hold logic.
 *
 * Pure and DOM-free so unit tests (`scripts/duplex-turn/check.test.mjs`) verify every state
 * transition directly. Strictly inactive when the default-OFF `labs.duplexTurnPolicy` toggle is
 * false, guaranteeing zero behavioral change for stock lalala voice sessions.
 */

export const DUPLEX_ACTIONS = [
  "ignore_background",
  "keep_listening",
  "pause_playback",
  "answer_now",
] as const;

export type DuplexAction = (typeof DUPLEX_ACTIONS)[number];

/** Model system state: `0` = idle/listening, `1` = assistant reply playing. */
export type DuplexSystemState = 0 | 1;

export type DuplexInference = {
  readonly action: DuplexAction;
  readonly probs: readonly [number, number, number, number];
  readonly logits: readonly [number, number, number, number];
  readonly state: DuplexSystemState;
  readonly at: number;
  readonly acousticFiller: boolean;
};

/** Max age (ms) of an ONNX worker decision before we fall back to stock rules. */
export const DUPLEX_STALE_MS = 1_200;

/** Confidence thresholds tuned for living-room precision without missing real speech. */
const IGNORE_BG_START_PROB = 0.7;
const IGNORE_BG_HOLD_PROB = 0.65;
const KEEP_LISTENING_HOLD_PROB = 0.55;
const BACKCHANNEL_SUPPRESS_PROB = 0.6;
const PAUSE_PLAYBACK_PROB = 0.6;
const ANSWER_NOW_PROB = 0.65;

/** Floor-hold extensions & snappy-commit caps (ms). */
const KEEP_LISTENING_EXT_MS = 1_200;
const UMAI_FILLER_EXT_MS = 1_600;
const COMBINED_HOLD_EXT_MS = 1_800;
const MAX_EXTENDED_WAIT_MS = 4_200;
const ANSWER_NOW_SHAVE_MS = 450;
const ANSWER_NOW_MIN_WAIT_MS = 650;
/** Require mic at least this far above the room floor before allowing duplex `pause_playback`. */
const DUPLEX_BARGE_OVER_FLOOR_DB = 6;

/**
 * Applies legal-state masking (`state=0` masks `pause_playback`, `state=1` masks `answer_now`),
 * computes softmax probabilities, and returns the winning action.
 */
export function applyDuplexDecision(
  rawLogits: ArrayLike<number>,
  state: DuplexSystemState,
): {
  readonly action: DuplexAction;
  readonly probs: [number, number, number, number];
  readonly logits: [number, number, number, number];
} {
  const masked: [number, number, number, number] = [
    Number(rawLogits[0] ?? 0),
    Number(rawLogits[1] ?? 0),
    Number(rawLogits[2] ?? 0),
    Number(rawLogits[3] ?? 0),
  ];
  if (state === 0) masked[2] = -1e9; // idle -> cannot pause_playback
  else masked[3] = -1e9; // reply playing -> cannot answer_now directly

  const maxLogit = Math.max(masked[0], masked[1], masked[2], masked[3]);
  const e0 = Math.exp(masked[0] - maxLogit);
  const e1 = Math.exp(masked[1] - maxLogit);
  const e2 = Math.exp(masked[2] - maxLogit);
  const e3 = Math.exp(masked[3] - maxLogit);
  const sum = e0 + e1 + e2 + e3 || 1;
  const probs: [number, number, number, number] = [e0 / sum, e1 / sum, e2 / sum, e3 / sum];

  let bestIdx = 0;
  for (let i = 1; i < 4; i += 1) {
    if (masked[i]! > masked[bestIdx]!) bestIdx = i;
  }
  return {
    action: DUPLEX_ACTIONS[bestIdx]!,
    probs,
    logits: masked,
  };
}

export type UmaiHesitation = {
  readonly detected: boolean;
  readonly source: "lexical" | "acoustic" | "both" | "none";
  readonly extensionMs: number;
};

// Filled-pause tokens from UMAI (`arXiv:2611.34256` §3.1) plus common English hesitation spellings.
// Explicitly excludes backchannel "uh-huh" / "uh huh" per UMAI §3.1!
const TRAILING_UH_HUH = /\buh[\s-]+huh\s*[,.…!?\-–—"')\]]*$/i;
const TRAILING_FILLED_PAUSE =
  /(?:^|[\s,;:(\-"'“‘])(?:\[(?:uh|um)\]|uh+m+|u+m+|u+h+|er+m*|hm+|mm+)\s*(?:\.{2,}|…|[,;:\-–—])*\s*["')\]]*$/i;
const TRAILING_ELLIPSIS = /(?:\.{2,}|…)["')\]]*$/;
const CLOSED_SENTENCE_END = /[.!?]["')\]]*$/;

/**
 * UMAI filled-pause ("uhm" / "uh") trailing-hesitation detector.
 *
 * Combines:
 *   1. Lexical end-gap filled-pause detection on the live STT partial (excluding "uh-huh").
 *   2. Acoustic end-gap filled-pause recovery from the duplex worker's causal prosody
 *      (catching sustained "uhm..." holds that streaming STT strips out, just as UMAI recovers
 *      85.7% of trailing fillers with 0% FP on frozen ASR).
 */
export function detectUmaiHesitation(partial: string, acousticFiller: boolean): UmaiHesitation {
  const trimmed = partial.trim();
  const isUhHuh = TRAILING_UH_HUH.test(trimmed);
  const lexical = !isUhHuh && trimmed !== "" && TRAILING_FILLED_PAUSE.test(trimmed);
  const closedSentence = CLOSED_SENTENCE_END.test(trimmed) && !TRAILING_ELLIPSIS.test(trimmed);
  // Acoustic fallback fires when the speaker hasn't closed a sentence with terminal punctuation.
  const acoustic = acousticFiller && !isUhHuh && !closedSentence;

  if (lexical && acoustic) return { detected: true, source: "both", extensionMs: UMAI_FILLER_EXT_MS };
  if (lexical) return { detected: true, source: "lexical", extensionMs: UMAI_FILLER_EXT_MS };
  if (acoustic) return { detected: true, source: "acoustic", extensionMs: UMAI_FILLER_EXT_MS };
  return { detected: false, source: "none", extensionMs: 0 };
}

export type DuplexPolicyInput = {
  /** Strictly follows `syncedSettings().labs.duplexTurnPolicy` (default false). */
  readonly enabled: boolean;
  readonly inference: DuplexInference | null;
  readonly now: number;
  readonly baseWaitMs: number;
  readonly baseRule: string;
  readonly partial: string;
  readonly hasRealWords: boolean;
  readonly replyAudible: boolean;
  readonly playerSpeaking: boolean;
  readonly playerHolding: boolean;
  readonly inSpeech: boolean;
  readonly turnVoiced: boolean;
  readonly micDb: number;
  readonly floorDb: number;
};

export type DuplexPolicyOutput = {
  readonly active: boolean;
  /** Suppress opening a new idle turn when the model sees background speech/echo/TV. */
  readonly suppressStart: boolean;
  /** Suppress a non-level barge-in hold when the model sees background echo or a backchannel. */
  readonly suppressHold: boolean;
  /** Trigger an immediate barge-in hold during playback on confident `pause_playback`. */
  readonly triggerHold: boolean;
  /** Effective silence timeout (ms) for ending the active turn. */
  readonly effectiveWaitMs: number;
  /** Diagnostic rule label logged in `turn.end`. */
  readonly rule: string;
  /** UMAI filled-pause detection result for telemetry & tests. */
  readonly umai: UmaiHesitation;
};

const PASSTHROUGH_UMAI: UmaiHesitation = { detected: false, source: "none", extensionMs: 0 };

/**
 * Evaluates the 4-action duplex turn policy + UMAI hesitation add-on for the current audio frame.
 * When `enabled` is false, returns an exact no-op passthrough.
 */
export function evaluateDuplexPolicy(input: DuplexPolicyInput): DuplexPolicyOutput {
  if (!input.enabled) {
    return {
      active: false,
      suppressStart: false,
      suppressHold: false,
      triggerHold: false,
      effectiveWaitMs: input.baseWaitMs,
      rule: input.baseRule,
      umai: PASSTHROUGH_UMAI,
    };
  }

  const inf =
    input.inference !== null && input.now - input.inference.at <= DUPLEX_STALE_MS
      ? input.inference
      : null;

  const umai = detectUmaiHesitation(input.partial, inf?.acousticFiller === true);

  let suppressStart = false;
  let suppressHold = false;
  let triggerHold = false;
  let effectiveWaitMs = input.baseWaitMs;
  let rule = input.baseRule;

  // --- Playback state (state = 1): barge-in vs background/backchannel suppression ---
  if (input.replyAudible) {
    if (inf !== null && inf.state === 1) {
      if (inf.action === "ignore_background" && inf.probs[0] >= IGNORE_BG_HOLD_PROB) {
        suppressHold = true;
      } else if (inf.action === "keep_listening" && inf.probs[1] >= BACKCHANNEL_SUPPRESS_PROB) {
        // Backchannel ("okay", "mhm", "cool") while assistant speaks: do not interrupt!
        suppressHold = true;
      } else if (
        inf.action === "pause_playback" &&
        inf.probs[2] >= PAUSE_PLAYBACK_PROB &&
        input.playerSpeaking &&
        !input.playerHolding &&
        input.micDb >= input.floorDb + DUPLEX_BARGE_OVER_FLOOR_DB
      ) {
        triggerHold = true;
      }
    }
    return {
      active: true,
      suppressStart,
      suppressHold,
      triggerHold,
      effectiveWaitMs,
      rule,
      umai,
    };
  }

  // --- Idle state (state = 0): background trigger suppression ---
  if (!input.inSpeech) {
    if (
      inf !== null &&
      inf.state === 0 &&
      inf.action === "ignore_background" &&
      inf.probs[0] >= IGNORE_BG_START_PROB
    ) {
      suppressStart = true;
    }
    return {
      active: true,
      suppressStart,
      suppressHold,
      triggerHold,
      effectiveWaitMs,
      rule,
      umai,
    };
  }

  // --- Active listening turn (state = 0, inSpeech = true): keep_listening + UMAI vs answer_now ---
  const modelKeepListening =
    inf !== null &&
    inf.state === 0 &&
    inf.action === "keep_listening" &&
    inf.probs[1] >= KEEP_LISTENING_HOLD_PROB;
  const modelAnswerNow =
    inf !== null &&
    inf.state === 0 &&
    inf.action === "answer_now" &&
    inf.probs[3] >= ANSWER_NOW_PROB;

  if (modelKeepListening && umai.detected) {
    effectiveWaitMs = Math.min(MAX_EXTENDED_WAIT_MS, input.baseWaitMs + COMBINED_HOLD_EXT_MS);
    rule = `duplex+umai-${umai.source}`;
  } else if (umai.detected) {
    effectiveWaitMs = Math.min(MAX_EXTENDED_WAIT_MS, input.baseWaitMs + umai.extensionMs);
    rule = `umai-${umai.source}`;
  } else if (modelKeepListening) {
    effectiveWaitMs = Math.min(MAX_EXTENDED_WAIT_MS, input.baseWaitMs + KEEP_LISTENING_EXT_MS);
    rule = "duplex-keep-listening";
  } else if (modelAnswerNow && input.turnVoiced && input.hasRealWords) {
    effectiveWaitMs = Math.min(
      input.baseWaitMs,
      Math.max(ANSWER_NOW_MIN_WAIT_MS, input.baseWaitMs - ANSWER_NOW_SHAVE_MS),
    );
    rule = "duplex-answer-now";
  }

  return {
    active: true,
    suppressStart,
    suppressHold,
    triggerHold,
    effectiveWaitMs,
    rule,
    umai,
  };
}
