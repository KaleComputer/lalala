import { useSyncExternalStore } from "react";

import type { useVoiceBrainContext } from "../state/voiceBrainContext";

/** The brain thread's context as the voice page needs it (state/voiceBrainContext, one per build). */
export type VoiceBrainContext = {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  /** When the provider last reported the usage (epoch ms). */
  readonly reportedAt: number;
  /** The prompt cache's lifetime from that report; Claude API keys get 5 min unless 1h is enabled. */
  readonly cacheTtlMs: number | null;
  /** Only Claude sessions compact. */
  readonly claude: boolean;
  /** A `/compact` run is in progress. */
  readonly compacting: boolean;
  /** When the latest compaction finished (epoch ms). */
  readonly compactedAt: number | null;
};

// T3's COMPACTION_SUGGESTION_MIN_TOKENS and its fallback cache lifetime (ContextWindowMeter.logic).
const COMPACT_FROM_TOKENS = 200_000;
const CACHE_FALLBACK_MS = 5 * 60_000;

/**
 * T3's "compact when you return" for the voice page: a big Claude context whose prompt cache has
 * expired, so the next turn would re-read all of it.
 */
export function compactionDue(context: VoiceBrainContext | null, nowMs: number): boolean {
  return (
    context !== null &&
    context.claude &&
    !context.compacting &&
    context.usedTokens >= COMPACT_FROM_TOKENS &&
    nowMs - context.reportedAt >= (context.cacheTtlMs ?? CACHE_FALLBACK_MS)
  );
}

export const formatTokens = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M`
    : `${Math.round(tokens / 1_000)}k`;

type BrainThreadRef = Parameters<typeof useVoiceBrainContext>[0];
let shared: BrainThreadRef = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** VoiceHost's brain thread, for the settings sheet (the bar renders it, without the thread). */
export function shareBrainThread(ref: BrainThreadRef): void {
  shared = ref;
  for (const listener of listeners) listener();
}

export const useSharedBrainThread = () => useSyncExternalStore(subscribe, () => shared);
