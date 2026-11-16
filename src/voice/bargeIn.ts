/**
 * When Tim's voice silences a playing reply (a hold), frame by frame and pure, so recorded traces
 * test it (scripts/barge-in-check.mjs). The voice detector (Silero) only adds a way in: without it
 * (loading, or out of memory on a phone: 15 Nov, every reply played over Tim) the close-talk gate
 * and the reply's own level decide alone, and noise and our echo still never hold a reply.
 */

// Our reply coming back through a speaker is quieter at the mic than the reply itself; Tim talking
// into it is not. A hold needs the mic within this many dB of what is playing, for HOLD_OVER_MS.
export const HOLD_OVER_REPLY_DB = 3;
export const HOLD_OVER_MS = 60;
// The voice detector's way in (13 Nov: "why do I have to talk so loud"): this much unbroken speech,
// at a normal voice's level: over the room's floor, and not so far under the reply that it is its echo.
export const VAD_HOLD_MS = 128;
// Any way in needs the mic this far over the room's floor.
export const OVER_FLOOR_DB = 10;
// Tim at a desk reaches the mic 10-18 dB under the reply (13-14 Nov holds that were his).
export const VAD_UNDER_REPLY_DB = 20;
// The reply's loudest moment in the last ~500 ms: its echo arrives late and rings on, and a pause
// between its phrases is not room for anyone else to count as over it.
const REPLY_FRAMES = 25;

export type BargeFrame = {
  readonly frameMs: number;
  /** The mic's level this frame (dBFS). */
  readonly micDb: number;
  /** What the reply plays right now (dBFS). */
  readonly replyDb: number;
  /** The close-talk gate in its speaking mode: someone talking close (voiced or open). */
  readonly close: boolean;
  /** The gate opened this frame on its barge-in bar (its BARGE_MS of clearly-Tim). */
  readonly openedOverReply: boolean;
  /** A voice is in the sound (the harmonic comb; always true until it is proven). */
  readonly voiceLike: boolean;
  /** The room's floor as the gate measures it (dBFS). */
  readonly floorDb: number;
  /** The voice detector: running, its unbroken speech so far, and speech this frame. */
  readonly vad: { readonly ready: boolean; readonly voiceMs: number; readonly voiceNow: boolean };
  /** A reply is playing and not held: a hold can start now. */
  readonly canHold: boolean;
};

export type BargeHold = "level" | "vad" | "gate";

export function createBargeHold() {
  const replyDbs: number[] = [];
  let overReplyMs = 0;
  let armed = true;
  let replyDb = Number.NEGATIVE_INFINITY;
  return {
    /** The reply's loudest level in the last ~500 ms, as the last step saw it. */
    get replyDb() {
      return replyDb;
    },
    /** Whether this frame holds the reply, and by what; a new hold needs a quiet moment first. */
    step(f: BargeFrame): BargeHold | null {
      const vadVoice = f.vad.ready && f.vad.voiceNow;
      if (!f.close && !vadVoice) armed = true;
      replyDbs.push(f.replyDb);
      if (replyDbs.length > REPLY_FRAMES) replyDbs.shift();
      replyDb = Math.max(...replyDbs);
      // Between the reply's words anything is over it: the mic must be loud in the room too.
      const overReply = f.micDb >= replyDb - HOLD_OVER_REPLY_DB && f.micDb >= f.floorDb + OVER_FLOOR_DB;
      overReplyMs = f.close && overReply && f.voiceLike ? overReplyMs + f.frameMs : 0;
      if (!armed || !f.canHold) return null;
      const by: BargeHold | null =
        overReplyMs >= HOLD_OVER_MS
          ? "level"
          : // The detector hears anyone's speech: people further off count only once they reach the
            // gate's barge-in bar, which is Tim's own close voice (15 Nov: "not any background noise").
            f.vad.ready &&
              f.close &&
              f.vad.voiceMs >= VAD_HOLD_MS &&
              f.micDb >= f.floorDb + OVER_FLOOR_DB &&
              f.micDb >= replyDb - VAD_UNDER_REPLY_DB
            ? "vad"
            : // Without the detector, the gate's own barge-in bar is the way in a normal voice has.
              !f.vad.ready && f.openedOverReply && f.voiceLike
              ? "gate"
              : null;
      if (by !== null) armed = false;
      return by;
    },
  };
}

/** Tim's voice over a held (silent) reply: the voice detector's word while it runs, else the gate's. */
export function voiceOverHold(f: Pick<BargeFrame, "close" | "voiceLike" | "vad">): boolean {
  return f.vad.ready ? f.vad.voiceNow : f.close && f.voiceLike;
}
