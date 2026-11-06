// Types for closetalk.js, Presence's close-talk gate.
export type CloseTalkMode = "listen" | "speak" | "think";
export interface CloseTalkDecision {
  readonly open: boolean;
  readonly opened: boolean;
  readonly closed: boolean;
  readonly voiced: boolean;
  readonly bar: number;
  readonly floor: number;
  readonly voice: number;
  readonly by: CloseTalkMode | null;
  readonly level: number;
}
export interface CloseTalk {
  step(db: number, mode?: CloseTalkMode, dtMs?: number): CloseTalkDecision;
  readonly open: boolean;
  readonly voiced: boolean;
  sensitivity: number;
  snapshot(): {
    open: boolean;
    voiced: boolean;
    floor: number;
    voice: number;
    bars: Record<CloseTalkMode, number>;
  };
}
export function createCloseTalk(options?: { sensitivity?: number }): CloseTalk;
export function dbOf(meanSquare: number): number;
