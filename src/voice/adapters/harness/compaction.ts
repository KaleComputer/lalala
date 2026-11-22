/**
 * Brain compaction context derived from T3's thread state: both explicit `/compact` runs and live
 * `type === "compaction"` turn items (for automatic mid-turn compaction on any provider).
 * Both harnesses (vite/t3bridge.mjs and src/voice/adapters/harness/browser.ts) run this, so it
 * imports nothing.
 */

export const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export type RawRun = {
  readonly id: string;
  readonly status: string;
  readonly userMessageId: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly workStartedAt?: string | null;
  readonly completedAt?: string | null;
};

export type SlimRun = {
  readonly status: string;
  readonly userMessageId: string;
  readonly workStartedAt: string | null;
  readonly completedAt: string | null;
};

export type RawUsage = {
  readonly usedTokens: number;
  readonly maxTokens?: number | null;
  readonly promptCacheTtlMs?: number | null;
  readonly updatedAt: string;
};

export type RawMessage = {
  readonly id: string;
  readonly role: string;
  readonly text?: string;
  readonly attachments?: readonly unknown[];
};

export type RawCompactionItem = {
  readonly id: string;
  readonly type: string;
  readonly runId?: string | null;
  readonly status?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt?: string | null;
};

export type SlimCompactionItem = {
  readonly id: string;
  readonly runId: string | null;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string | null;
};

export type VisibleTurnItem = {
  readonly visibility?: string;
  readonly item: RawCompactionItem;
};

export type BrainContextState = {
  readonly usage: RawUsage | null;
  readonly claude: boolean;
  readonly runs: ReadonlyMap<string, SlimRun>;
  readonly compactions: ReadonlySet<string>;
  readonly compactionItems: ReadonlyMap<string, SlimCompactionItem>;
};

export type DerivedBrainContext = {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly reportedAt: number;
  readonly cacheTtlMs: number | null;
  readonly claude: boolean;
  readonly compacting: boolean;
  readonly compactedAt: number | null;
  readonly compactStartedAt: number | null;
  readonly compactTookMs: readonly number[];
};

export const isCompactionMessage = (message: RawMessage): boolean =>
  message.role === "user" &&
  message.text?.trim().toLowerCase() === "/compact" &&
  (message.attachments?.length ?? 0) === 0;

export const slimRun = (run: RawRun): SlimRun => ({
  status: run.status,
  userMessageId: run.userMessageId,
  // T3's orchestrationV2RunWorkStartedAt: when the run began its work.
  workStartedAt: run.workStartedAt ?? run.startedAt ?? run.requestedAt ?? null,
  completedAt: run.completedAt ?? null,
});

export const slimCompactionItem = (item: RawCompactionItem): SlimCompactionItem => ({
  id: item.id,
  runId: item.runId ?? null,
  status: item.status ?? null,
  startedAt: item.startedAt ?? null,
  completedAt: item.completedAt ?? null,
  updatedAt: item.updatedAt ?? null,
});

/** Extracts this thread's own `compaction` turn items from a T3 thread snapshot. */
export function collectCompactionItems(
  visibleTurnItems: readonly VisibleTurnItem[],
): Map<string, SlimCompactionItem> {
  const items = new Map<string, SlimCompactionItem>();
  for (const row of visibleTurnItems) {
    if (row.visibility === "inherited" || row.item.type !== "compaction") continue;
    items.set(row.item.id, slimCompactionItem(row.item));
  }
  return items;
}

const parseTime = (value: string | null | undefined): number | null => {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Derives `VoiceBrainContext` from a thread's latest usage, `/compact` runs, and live
 * `type === "compaction"` turn items. Returns `null` only when neither usage nor compaction
 * activity is known yet.
 */
export function deriveBrainContext(state: BrainContextState): DerivedBrainContext | null {
  let compacting = false;
  let compactedAt: number | null = null;
  let compactStartedAt: number | null = null;
  const finished: Array<{ readonly done: number; readonly tookMs: number }> = [];
  const timedItemRunIds = new Set<string>();

  for (const item of state.compactionItems.values()) {
    const run = item.runId === null ? undefined : state.runs.get(item.runId);
    const runFinished = run !== undefined && !ACTIVE_RUN.has(run.status);
    const began = parseTime(item.startedAt);
    if (item.status === "running" && !runFinished) {
      compacting = true;
      const started = began ?? parseTime(item.updatedAt);
      if (started !== null) {
        compactStartedAt = compactStartedAt === null ? started : Math.min(compactStartedAt, started);
      }
    } else if (item.status === "completed") {
      const done = parseTime(item.completedAt) ?? parseTime(item.updatedAt);
      if (done !== null) {
        compactedAt = Math.max(compactedAt ?? 0, done);
        if (began !== null && done >= began) {
          finished.push({ done, tookMs: done - began });
          if (item.runId !== null) timedItemRunIds.add(item.runId);
        }
      }
    }
  }

  for (const [runId, run] of state.runs.entries()) {
    if (!state.compactions.has(run.userMessageId)) continue;
    const began = parseTime(run.workStartedAt);
    if (ACTIVE_RUN.has(run.status)) {
      compacting = true;
      if (began !== null) {
        compactStartedAt = compactStartedAt === null ? began : Math.min(compactStartedAt, began);
      }
    } else if (run.status === "completed") {
      const done = parseTime(run.completedAt);
      if (done !== null) {
        compactedAt = Math.max(compactedAt ?? 0, done);
        if (began !== null && done >= began && !timedItemRunIds.has(runId)) {
          finished.push({ done, tookMs: done - began });
        }
      }
    }
  }

  if (state.usage === null && !compacting && compactedAt === null) return null;

  finished.sort((a, b) => a.done - b.done);
  return {
    usedTokens: state.usage?.usedTokens ?? 0,
    maxTokens: state.usage?.maxTokens ?? null,
    reportedAt: parseTime(state.usage?.updatedAt) ?? 0,
    cacheTtlMs: state.usage?.promptCacheTtlMs ?? null,
    claude: state.claude,
    compacting,
    compactedAt,
    compactStartedAt,
    compactTookMs: finished.map((entry) => entry.tookMs),
  };
}
