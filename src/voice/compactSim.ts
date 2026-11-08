import { useSyncExternalStore } from "react";

/** A pretend compaction for checking the bar's compacting view in dev (VoiceSettings, dev only). */
export type CompactSim = {
  readonly active: boolean;
  readonly startedAt: number;
  readonly estimateMs: number;
};

let sim: CompactSim | null = null;
let timer = 0;
const listeners = new Set<() => void>();
const set = (next: CompactSim | null) => {
  sim = next;
  for (const listener of listeners) listener();
};

/** Runs a pretend compaction that ends after `ms`, as expected; nothing is sent to the brain. */
export function startCompactSim(ms: number): void {
  window.clearTimeout(timer);
  const run = { active: true, startedAt: Date.now(), estimateMs: ms };
  set(run);
  timer = window.setTimeout(() => finishCompactSim(), ms);
}

/** Ends the pretend compaction now; the bar packs the rest fast. */
export function finishCompactSim(): void {
  window.clearTimeout(timer);
  if (sim?.active) set({ ...sim, active: false });
}

export const useCompactSim = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sim,
  );
