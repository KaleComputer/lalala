/**
 * Holds what the brain brings in from outside (`[new topic]` parts) while the user's own turn is
 * open: they talk, their words are on their way, or the answer to them hasn't been heard yet ("I'm
 * talking with you, I'm expecting an answer"). Then the topics play one at a time, in order.
 */

// No answer to their words in this long (a failed turn, a brain that stayed silent): the topics go.
export const ANSWER_WAIT_MS = 45_000;
// Quiet between the end of what was heard and a held topic, so it never runs into the answer.
export const TOPIC_GAP_MS = 1_200;

export type TopicSentence = {
  readonly text: string;
  readonly topic: string | undefined;
  readonly switching: boolean;
  /** Which `[new topic]` part of which reply it belongs to; its sentences stay together. */
  readonly part: string;
};

export class TopicHold {
  private held: TopicSentence[] = [];
  private awaitingSince: number | null = null;
  private busyAt = Number.NEGATIVE_INFINITY;
  /** The part playing now: its later sentences follow it straight away. */
  private playing: string | null = null;

  /** The user's words went to the brain: topics wait for its answer. */
  awaitAnswer(now: number): void {
    this.awaitingSince = now;
    this.playing = null;
  }

  /** The brain's answer to their words is complete (it may still be playing). */
  answered(): void {
    this.awaitingSince = null;
  }

  /** How many topics are held. */
  get count(): number {
    return new Set(this.held.map((sentence) => sentence.part)).size;
  }

  awaiting(now: number): boolean {
    return this.awaitingSince !== null && now - this.awaitingSince < ANSWER_WAIT_MS;
  }

  /**
   * Takes a `[new topic]` sentence if it has to wait (true); `busy` is the user having the floor or
   * something still being heard.
   */
  hold(sentence: TopicSentence, busy: boolean, now: number): boolean {
    if (busy) this.busyAt = now;
    if (sentence.part === this.playing) return false;
    if (this.held.length > 0 || busy || this.awaiting(now)) {
      this.held.push(sentence);
      return true;
    }
    this.playing = sentence.part;
    return false;
  }

  /** The next held topic's sentences once it may play (after the answer and a gap), else none. */
  next(busy: boolean, now: number): TopicSentence[] {
    if (busy) {
      this.busyAt = now;
      return [];
    }
    const first = this.held[0];
    if (first === undefined || this.awaiting(now) || now - this.busyAt < TOPIC_GAP_MS) return [];
    const end = this.held.findIndex((sentence) => sentence.part !== first.part);
    const topic = this.held.splice(0, end < 0 ? this.held.length : end);
    this.playing = first.part;
    this.busyAt = now;
    return topic;
  }

  /** A topic cut off by the user goes back to the front, whole, to play after their answer. */
  requeue(sentences: ReadonlyArray<TopicSentence>): void {
    this.held.unshift(...sentences);
    this.playing = null;
  }

  clear(): void {
    this.held = [];
    this.awaitingSince = null;
    this.playing = null;
  }
}

/**
 * A reply silenced because the user's voice came over it: quiet again within `releaseMs` it was a cough
 * and goes on; still talking `maxMs` after the hold, it is their turn and the reply stops.
 */
export function heldReply(
  now: number,
  heldAt: number,
  voiceAt: number,
  releaseMs: number,
  maxMs: number,
): "wait" | "release" | "stop" {
  if (now - Math.max(voiceAt, heldAt) >= releaseMs) return "release";
  return now - heldAt >= maxMs ? "stop" : "wait";
}
