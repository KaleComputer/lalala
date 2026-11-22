/**
 * Live agent progress & monitor projection: turns T3 delegate thread shells, delegate turn items,
 * and brain-thread delegated_task notifications into a compact, sortable list of `AgentRun` items.
 * Zero external imports so both the Vite bridge (vite/t3bridge.mjs), the browser harness, the UI,
 * and Node unit tests share one source of truth.
 */

export type AgentStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export type AgentRun = {
  /** Delegate thread id in T3 Code. */
  readonly id: string;
  /** Thread title (from T3 shell or delegate thread snapshot). */
  readonly title: string;
  /** Normalized lifecycle status. */
  readonly status: AgentStatus;
  /** Concise label for the latest tool/step (e.g. "Editing VoiceBar.tsx", "Thinking…"). */
  readonly step: string | null;
  /** ISO timestamp when this delegate run began. */
  readonly startedAt: string;
  /** ISO timestamp when this delegate run finished, or null while running/waiting. */
  readonly completedAt: string | null;
  /** ISO timestamp of the latest activity observed on this delegate. */
  readonly updatedAt: string;
  /** Direct T3 Code URL for the delegate thread, when known. */
  readonly link: string | null;
  /** Linked canvas card id (from `[about: <id>]`), when known. */
  readonly card: string | null;
};

export type RawPendingBackgroundTask = {
  readonly taskId?: string | null;
  readonly kind?: string | null;
  readonly description?: string | null;
  readonly childThreadId?: string | null;
  readonly awaited?: boolean;
};

export type RawDelegateThread = {
  readonly id: string;
  readonly title?: string | null;
  readonly activeRunId?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly pendingRuntimeRequest?: { readonly id?: string | null; readonly kind?: string | null } | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<RawPendingBackgroundTask> | null;
  readonly latestRunStatus?: string | null;
  readonly runtime?: { readonly status?: string | null } | null;
  readonly parentThreadId?: string | null;
  readonly relationshipToParent?: string | null;
  readonly lineage?: {
    readonly relationshipToParent?: string | null;
    readonly rootThreadId?: string | null;
    readonly parentThreadId?: string | null;
  } | null;
};

export type RawSubagentTurnItem = {
  readonly id?: string | null;
  readonly itemId?: string | null;
  readonly type?: string | null;
  readonly status?: string | null;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly label?: string | null;
  readonly childThreadId?: string | null;
  readonly subagentThreadId?: string | null;
  readonly targetThreadId?: string | null;
  readonly thread?: { readonly id?: string | null } | null;
  readonly source?: { readonly kind?: string | null; readonly childThreadId?: string | null } | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt?: string | null;
};

export type RawRun = {
  readonly id?: string;
  readonly status?: string | null;
  readonly workStartedAt?: string | null;
  readonly startedAt?: string | null;
  readonly requestedAt?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt?: string | null;
};

export type RawTurnItem = {
  readonly id?: string;
  readonly type?: string;
  readonly runId?: string | null;
  readonly threadId?: string | null;
  readonly status?: string | null;
  readonly secretStatus?: string | null;
  readonly streaming?: boolean;
  readonly retry?: unknown;
  readonly text?: string | null;
  readonly toolSummary?: string | null;
  readonly summary?: string | null;
  readonly title?: string | null;
  readonly label?: string | null;
  readonly name?: string | null;
  readonly toolName?: string | null;
  readonly command?: string | null;
  readonly path?: string | null;
  readonly filePath?: string | null;
  readonly query?: string | null;
  readonly arguments?: Readonly<Record<string, unknown>> | null;
  readonly input?: Readonly<Record<string, unknown>> | null;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
};

export type BrainNotificationRow = {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly parentItemId: string | null;
    readonly startedAt: string | null;
    readonly updatedAt: string;
    readonly runId?: string | null;
    readonly trigger?: {
      readonly kind: string;
      readonly threadId: string | null;
      readonly outcome: string | null;
      readonly lead: string;
    } | null;
  };
};

export type AgentLinkContext = {
  readonly titleOf: (threadId: string) => string | null;
  readonly linkOf: (threadId: string) => string | null;
};

const MAX_STEP_CHARS = 72;
const DEFAULT_MAX_AGENTS = 30;
const ABOUT_CARD = /\[about:\s*([^\]]+)\]/i;
const IGNORED_STEP_TYPES = new Set([
  "user_message",
  "checkpoint",
  "system_notice",
  "notification",
]);
const WAIT_TYPES = new Set([
  "secret_request",
  "approval_request",
  "permission_request",
  "user_input_request",
  "question",
]);
const TRANSIENT_STEPS = new Set(["Thinking…", "Writing reply…", "Retrying…"]);

const clip = (text: string, max = MAX_STEP_CHARS): string => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const basename = (raw: string): string => {
  const trimmed = raw.trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.at(-1) || trimmed;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
};

const humanizeToolName = (raw: string): string => {
  const clean = raw.trim().replace(/^mcp_[^_]+_/, "");
  const known: Readonly<Record<string, string>> = {
    read_file: "Reading file",
    edit_file: "Editing file",
    write_file: "Writing file",
    run_command: "Running command",
    search_web: "Searching web",
    delegate_task: "Delegating task",
    t3_thread_read: "Reading thread",
    t3_thread_send: "Messaging thread",
    list_dir: "Listing directory",
    grep_search: "Searching code",
    find_by_name: "Finding files",
  };
  if (clean in known) return known[clean]!;
  const words = clean.replace(/[_-]+/g, " ").trim();
  return words === "" ? "Working…" : words[0]!.toUpperCase() + words.slice(1);
};

export const isActiveAgent = (agent: Pick<AgentRun, "status">): boolean =>
  agent.status === "running" || agent.status === "waiting";

/** Maps T3 run/thread statuses to the monitor's five states. */
export function normalizeRunStatus(status: unknown): AgentStatus {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "waiting" || s === "awaiting_input" || s === "awaiting_approval") return "waiting";
  if (s === "preparing" || s === "queued" || s === "starting" || s === "running") return "running";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "interrupted" || s === "rolled_back") {
    return "cancelled";
  }
  return "completed";
}

/** Whether a delegate turn item is actively waiting on user input, approval, or a secret. */
export function isPendingWaitItem(item: RawTurnItem | null | undefined): boolean {
  if (!item || typeof item.type !== "string") return false;
  if (item.type === "secret_request") return item.secretStatus === "pending";
  if (WAIT_TYPES.has(item.type)) {
    return item.status === "pending" || item.status === "waiting" || item.status == null;
  }
  return false;
}

/** Extracts the first `[about: <card-id>]` card reference from text, if present. */
export function extractLinkedCard(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text === "") return null;
  const match = ABOUT_CARD.exec(text)?.[1]?.replace(/[`"]/g, "").trim();
  return match || null;
}

/**
 * Turns a raw T3 turn item from a delegate thread into a short, human-readable current step label,
 * or null when the item is bookkeeping that should not replace the current step.
 */
export function describeTurnItemStep(item: RawTurnItem | null | undefined): string | null {
  if (!item || typeof item.type !== "string" || IGNORED_STEP_TYPES.has(item.type)) return null;
  const type = item.type;

  if (type === "secret_request") {
    if (item.secretStatus !== "pending") return null;
    const label = firstString(item.label, item.title);
    return label ? clip(`Waiting for secret: ${label}`) : "Waiting for secret";
  }
  if (type === "approval_request" || type === "permission_request") {
    if (!isPendingWaitItem(item)) return null;
    const label = firstString(item.title, item.label, item.summary);
    return label ? clip(`Waiting for approval: ${label}`) : "Waiting for approval";
  }
  if (type === "user_input_request" || type === "question") {
    if (!isPendingWaitItem(item)) return null;
    const label = firstString(item.title, item.label, item.summary);
    return label ? clip(`Waiting for input: ${label}`) : "Waiting for input";
  }
  if (type === "reasoning" || type === "thinking") return "Thinking…";
  if (type === "assistant_message") return item.streaming === true ? "Writing reply…" : null;
  if (type === "error") {
    if (item.status === "running" && item.retry != null) return "Retrying…";
    const detail = firstString(item.summary, item.text);
    return detail ? clip(`Error: ${detail}`) : "Error";
  }

  const args = item.arguments ?? item.input ?? null;
  const argToolSummary = firstString(args?.toolSummary);
  const summary = firstString(item.toolSummary, argToolSummary, item.summary, item.title, item.label);
  if (summary) return clip(summary);

  const command = firstString(item.command, args?.command, args?.CommandLine);
  if (command) {
    const firstLine = command.split(/\r?\n/, 1)[0] ?? command;
    return clip(`Running ${firstLine}`);
  }

  const filePath = firstString(item.filePath, item.path, args?.path, args?.Path, args?.file_path);
  const toolName = firstString(item.toolName, item.name);
  if (filePath) {
    const verb =
      toolName && /read|view|open|cat/i.test(toolName)
        ? "Reading"
        : toolName && /write|create/i.test(toolName)
          ? "Writing"
          : "Editing";
    return clip(`${verb} ${basename(filePath)}`);
  }

  const query = firstString(item.query, args?.query, args?.pattern);
  if (query) return clip(`Searching ${query}`);

  if (toolName) return clip(humanizeToolName(toolName));

  return clip(humanizeToolName(type));
}

/** Whether a shell thread belongs to the brain as a delegated subagent. */
export function isBrainDelegateThread(
  thread: RawDelegateThread | null | undefined,
  brainThreadId: string | null,
): boolean {
  if (!thread || !brainThreadId) return false;
  const relationship = thread.lineage?.relationshipToParent ?? thread.relationshipToParent;
  if (relationship !== "subagent") return false;
  return (
    thread.lineage?.rootThreadId === brainThreadId ||
    thread.lineage?.parentThreadId === brainThreadId ||
    thread.parentThreadId === brainThreadId
  );
}

/**
 * Whether a delegate thread is waiting (on a secret/approval prompt, an awaited background
 * command/subagent, or a T3 `waiting` status) even if its current turn already ended (`activeRunId == null`).
 */
export function isShellThreadWaiting(thread: RawDelegateThread | null | undefined): boolean {
  if (!thread) return false;
  if (thread.pendingRuntimeRequest != null) return true;
  if (Array.isArray(thread.pendingBackgroundTasks) && thread.pendingBackgroundTasks.length > 0) {
    return true;
  }
  return typeof thread.status === "string" && normalizeRunStatus(thread.status) === "waiting";
}

/** Whether a delegate thread shell represents an in-progress run (running or waiting). */
export function isShellThreadActive(thread: RawDelegateThread | null | undefined): boolean {
  if (!thread) return false;
  if (thread.activeRunId != null) return true;
  if (isShellThreadWaiting(thread)) return true;
  return (
    typeof thread.status === "string" && isActiveAgent({ status: normalizeRunStatus(thread.status) })
  );
}

/** Resolves the delegated child thread id from a brain `subagent` turn item, if derivable. */
export function subagentThreadIdOf(item: RawSubagentTurnItem | null | undefined): string | null {
  if (!item) return null;
  const explicit = firstString(
    item.childThreadId,
    item.subagentThreadId,
    item.targetThreadId,
    item.thread?.id,
    item.source?.childThreadId,
  );
  if (explicit) return explicit;
  const id = firstString(item.id, item.itemId);
  if (id && id.startsWith("turn-item:delegated-task:")) {
    return `thread:${id.slice("turn-item:".length)}`;
  }
  return null;
}

/**
 * Projects a T3 shell thread update for a delegate into its `AgentRun` entry.
 * Preserves existing `startedAt`, `step`, and `card` while updating live/finished status.
 */
export function projectDelegateShell(
  prev: AgentRun | undefined,
  thread: RawDelegateThread,
  link: string | null,
  nowIso = new Date().toISOString(),
): AgentRun {
  const title = firstString(thread.title, prev?.title) ?? thread.id.slice(-8);
  const resolvedLink = link ?? prev?.link ?? null;
  const active = isShellThreadActive(thread);
  const updatedAt = firstString(thread.updatedAt, prev?.updatedAt) ?? nowIso;

  if (active) {
    const waitingPrompt = thread.pendingRuntimeRequest != null;
    const waitingBackground =
      thread.activeRunId == null && isShellThreadWaiting(thread);
    const status: AgentStatus =
      waitingPrompt || waitingBackground
        ? "waiting"
        : prev?.status === "waiting" && thread.activeRunId != null
          ? "waiting"
          : "running";
    const startedAt =
      prev && isActiveAgent(prev)
        ? prev.startedAt
        : firstString(thread.createdAt, thread.updatedAt) ?? nowIso;
    const bgStep = waitingBackground
      ? firstString(thread.pendingBackgroundTasks?.[0]?.description)
      : null;
    const step =
      prev && isActiveAgent(prev)
        ? (prev.step ?? (bgStep ? clip(bgStep) : null))
        : bgStep
          ? clip(bgStep)
          : null;
    return {
      id: thread.id,
      title,
      status,
      step,
      startedAt,
      completedAt: null,
      updatedAt,
      link: resolvedLink,
      card: prev?.card ?? null,
    };
  }

  // Inactive on shell: if previously active (or seen completed on snapshot), record terminal state.
  const rawTerminal = firstString(thread.latestRunStatus, thread.status, thread.runtime?.status);
  const terminal = rawTerminal ? normalizeRunStatus(rawTerminal) : null;
  const status: AgentStatus =
    terminal && !isActiveAgent({ status: terminal })
      ? terminal
      : prev && !isActiveAgent(prev)
        ? prev.status
        : "completed";
  const completedAt = prev?.completedAt ?? firstString(thread.updatedAt) ?? nowIso;
  const startedAt = prev?.startedAt ?? firstString(thread.createdAt, thread.updatedAt) ?? completedAt;
  const step =
    prev?.step && !TRANSIENT_STEPS.has(prev.step) && !prev.step.startsWith("Waiting for ")
      ? prev.step
      : null;

  return {
    id: thread.id,
    title,
    status,
    step,
    startedAt,
    completedAt,
    updatedAt: completedAt,
    link: resolvedLink,
    card: prev?.card ?? null,
  };
}

/** Projects a delegate's `run.created` / `run.updated` event onto its `AgentRun`. */
export function projectDelegateRun(
  prev: AgentRun,
  run: RawRun | null | undefined,
  nowIso = new Date().toISOString(),
  options?: { readonly threadWaiting?: boolean },
): AgentRun {
  if (!run) return prev;
  const rawStatus = run.status ? normalizeRunStatus(run.status) : prev.status;
  const status: AgentStatus =
    options?.threadWaiting === true && !isActiveAgent({ status: rawStatus }) ? "waiting" : rawStatus;
  const active = isActiveAgent({ status });
  const startedAt = firstString(run.workStartedAt, run.startedAt, run.requestedAt) ?? prev.startedAt;
  const completedAt = active
    ? null
    : firstString(run.completedAt, prev.completedAt, run.updatedAt) ?? nowIso;
  const updatedAt = firstString(run.updatedAt, run.completedAt, prev.updatedAt) ?? nowIso;
  const step =
    !active && prev.step && (TRANSIENT_STEPS.has(prev.step) || prev.step.startsWith("Waiting for "))
      ? null
      : prev.step;
  return {
    ...prev,
    status,
    startedAt,
    completedAt,
    updatedAt,
    step,
  };
}

/**
 * Projects a brain thread's `type: "subagent"` turn item into an `AgentRun` entry.
 * Works directly from `orchestration.subscribeThread` (snapshot + `turn-item.updated`) even
 * before shell deltas arrive or while a child thread waits on a background task.
 */
export function projectBrainSubagentItem(
  prev: AgentRun | undefined,
  item: RawSubagentTurnItem | null | undefined,
  context: AgentLinkContext,
  nowIso = new Date().toISOString(),
): AgentRun | null {
  if (!item || item.type !== "subagent") return null;
  const id = subagentThreadIdOf(item) ?? firstString(item.id, item.itemId);
  if (!id) return null;

  const incomingStatus = item.status ? normalizeRunStatus(item.status) : prev?.status ?? "running";
  const incomingActive = isActiveAgent({ status: incomingStatus });
  const title = firstString(
    context.titleOf(id),
    item.title,
    item.summary,
    item.label,
    prev?.title,
  );
  if (!title) return null;
  const link = context.linkOf(id) ?? prev?.link ?? null;
  const startedAt = firstString(item.startedAt, item.updatedAt, prev?.startedAt) ?? nowIso;
  const updatedAt = firstString(item.updatedAt, item.completedAt, item.startedAt) ?? nowIso;

  // Guard against out-of-order replay: never downgrade a newer active run from an older finished item,
  // and never resurrect a finished run from an older active item.
  if (prev && isActiveAgent(prev) && !incomingActive) {
    const prevStart = Date.parse(prev.startedAt);
    const itemEnd = Date.parse(firstString(item.completedAt, item.updatedAt) ?? "");
    if (Number.isFinite(prevStart) && Number.isFinite(itemEnd) && itemEnd < prevStart) {
      return prev;
    }
  }
  if (prev && !isActiveAgent(prev) && incomingActive) {
    const prevEnd = Date.parse(prev.completedAt ?? prev.updatedAt);
    const itemStart = Date.parse(firstString(item.startedAt, item.updatedAt) ?? "");
    if (Number.isFinite(prevEnd) && Number.isFinite(itemStart) && itemStart < prevEnd) {
      return prev;
    }
  }

  if (incomingActive) {
    const status: AgentStatus =
      incomingStatus === "waiting" || prev?.status === "waiting" ? "waiting" : "running";
    return {
      id,
      title,
      status,
      step: prev && isActiveAgent(prev) ? prev.step : null,
      startedAt: prev && isActiveAgent(prev) ? prev.startedAt : startedAt,
      completedAt: null,
      updatedAt,
      link,
      card: prev?.card ?? null,
    };
  }

  const completedAt = firstString(item.completedAt, item.updatedAt, prev?.completedAt) ?? nowIso;
  const step =
    prev?.step && !TRANSIENT_STEPS.has(prev.step) && !prev.step.startsWith("Waiting for ")
      ? prev.step
      : null;

  return {
    id,
    title,
    status: incomingStatus,
    step,
    startedAt: prev?.startedAt ?? startedAt,
    completedAt,
    updatedAt: completedAt,
    link,
    card: prev?.card ?? null,
  };
}

/**
 * Projects the brain thread's `pendingBackgroundTasks` (`kind: "subagent"`) so every in-flight
 * delegate appears active immediately on connect and stays active until removed.
 */
export function projectBrainPendingTasks(
  current: ReadonlyMap<string, AgentRun>,
  tasks: ReadonlyArray<RawPendingBackgroundTask> | null | undefined,
  context: AgentLinkContext,
  nowIso = new Date().toISOString(),
): { readonly agents: Map<string, AgentRun>; readonly activeIds: Set<string> } {
  const next = new Map(current);
  const activeIds = new Set<string>();
  if (!Array.isArray(tasks) || tasks.length === 0) return { agents: next, activeIds };

  for (const task of tasks) {
    if (task?.kind !== "subagent") continue;
    const threadId = firstString(
      task.childThreadId,
      task.taskId?.startsWith("turn-item:delegated-task:")
        ? `thread:${task.taskId.slice("turn-item:".length)}`
        : null,
    );
    if (!threadId) continue;
    activeIds.add(threadId);
    const existing = next.get(threadId);
    const title = firstString(context.titleOf(threadId), task.description, existing?.title) ?? threadId.slice(-8);
    const link = context.linkOf(threadId) ?? existing?.link ?? null;
    if (existing && isActiveAgent(existing)) {
      if (existing.title !== title || existing.link !== link) {
        next.set(threadId, { ...existing, title, link });
      }
      continue;
    }
    next.set(threadId, {
      id: threadId,
      title,
      status: "running",
      step: existing?.step ?? null,
      startedAt: existing?.startedAt ?? nowIso,
      completedAt: null,
      updatedAt: nowIso,
      link,
      card: existing?.card ?? null,
    });
  }
  return { agents: next, activeIds };
}

/** Projects a delegate's `turn-item.updated` event onto its `AgentRun`. */
export function projectDelegateTurnItem(
  prev: AgentRun,
  item: RawTurnItem | null | undefined,
  activeRunId?: string | null,
  nowIso = new Date().toISOString(),
): AgentRun {
  if (!item) return prev;
  if (activeRunId && item.runId && item.runId !== activeRunId) return prev;

  const step = describeTurnItemStep(item);
  const waiting = isPendingWaitItem(item);
  const card = extractLinkedCard(item.text) ?? prev.card;
  const updatedAt = firstString(item.updatedAt, item.startedAt) ?? nowIso;

  let status = prev.status;
  if (waiting) {
    status = "waiting";
  } else if (prev.status === "waiting" && (item.type === "secret_request" || WAIT_TYPES.has(item.type ?? ""))) {
    status = "running";
  } else if (prev.status === "waiting" && step !== null) {
    status = "running";
  }

  const nextStep =
    step !== null
      ? step
      : item.type === "secret_request" && item.secretStatus !== "pending" && prev.step?.startsWith("Waiting for secret")
        ? "Resuming…"
        : prev.step;

  if (
    status === prev.status &&
    nextStep === prev.step &&
    card === prev.card &&
    updatedAt === prev.updatedAt
  ) {
    return prev;
  }

  return {
    ...prev,
    status,
    step: nextStep,
    card,
    updatedAt,
  };
}

/**
 * Enriches or backfills recent finished delegate runs from the brain thread's `delegated_task`
 * notification rows (preserving live running entries and attaching `[about: <card>]` links).
 */
export function projectBrainNotificationAgents(
  current: ReadonlyMap<string, AgentRun>,
  rows: Iterable<BrainNotificationRow>,
  context: AgentLinkContext,
): Map<string, AgentRun> {
  const repliesByRun = new Map<string, string>();
  const notifications: BrainNotificationRow["item"][] = [];
  for (const { item } of rows) {
    if (item.trigger?.kind === "delegated" && item.trigger.threadId) {
      notifications.push(item);
    } else if (
      item.type === "assistant_message" &&
      item.parentItemId === null &&
      item.runId &&
      !item.streaming &&
      item.text.trim() !== ""
    ) {
      repliesByRun.set(item.runId, item.text);
    }
  }
  if (notifications.length === 0) return new Map(current);

  const next = new Map(current);
  for (const item of notifications) {
    const trigger = item.trigger!;
    const threadId = trigger.threadId!;
    const existing = next.get(threadId);
    const replyText = item.runId ? repliesByRun.get(item.runId) : undefined;
    const card = extractLinkedCard(replyText) ?? existing?.card ?? null;
    const completedAt = item.startedAt ?? item.updatedAt;
    const outcomeStatus = trigger.outcome ? normalizeRunStatus(trigger.outcome) : "completed";
    const title = firstString(
      context.titleOf(threadId),
      existing?.title,
      trigger.lead ? clip(trigger.lead, 64) : null,
    );
    if (!title) continue;
    const link = context.linkOf(threadId) ?? existing?.link ?? null;

    // Never downgrade an actively running delegate from an older notification of an earlier run.
    if (existing && isActiveAgent(existing)) {
      const existingStart = Date.parse(existing.startedAt);
      const notifAt = Date.parse(completedAt);
      if (!Number.isFinite(existingStart) || !Number.isFinite(notifAt) || notifAt < existingStart) {
        if (card !== existing.card || link !== existing.link || title !== existing.title) {
          next.set(threadId, { ...existing, title, link, card });
        }
        continue;
      }
    }

    const existingCompleted = existing?.completedAt ? Date.parse(existing.completedAt) : NaN;
    const notifCompleted = Date.parse(completedAt);
    if (
      existing &&
      !isActiveAgent(existing) &&
      Number.isFinite(existingCompleted) &&
      Number.isFinite(notifCompleted) &&
      notifCompleted < existingCompleted
    ) {
      if (card && !existing.card) next.set(threadId, { ...existing, card });
      continue;
    }

    const step =
      existing?.step && !TRANSIENT_STEPS.has(existing.step) && !existing.step.startsWith("Waiting for ")
        ? existing.step
        : trigger.lead
          ? clip(trigger.lead)
          : null;

    next.set(threadId, {
      id: threadId,
      title,
      status: outcomeStatus,
      step,
      startedAt: existing?.startedAt ?? completedAt,
      completedAt: existing?.completedAt ?? completedAt,
      updatedAt: completedAt,
      link,
      card,
    });
  }
  return next;
}

const timeMs = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Sorts agents with active runs first (newest started first), followed by recently finished runs
 * (newest completed/updated first). Always retains all active agents plus recent finished ones up to `max`.
 */
export function sortAgents(agents: Iterable<AgentRun>, max = DEFAULT_MAX_AGENTS): AgentRun[] {
  const active: AgentRun[] = [];
  const finished: AgentRun[] = [];
  for (const agent of agents) {
    if (isActiveAgent(agent)) active.push(agent);
    else finished.push(agent);
  }
  active.sort((a, b) => timeMs(b.startedAt) - timeMs(a.startedAt) || a.id.localeCompare(b.id));
  finished.sort(
    (a, b) =>
      timeMs(b.completedAt ?? b.updatedAt) - timeMs(a.completedAt ?? a.updatedAt) ||
      a.id.localeCompare(b.id),
  );
  const keepFinished = Math.max(0, max - active.length);
  return [...active, ...finished.slice(0, keepFinished)];
}

/** Compact elapsed time between `startedAt` and `endMs` ("14s", "2m 08s", "1h 05m"). */
export function formatElapsed(startedAt: string, endMs: number): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(endMs)) return "0s";
  const totalSec = Math.max(0, Math.floor((endMs - start) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, "0")}m`;
}

/** Total run duration when both timestamps are valid and positive, else null. */
export function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return formatElapsed(startedAt, end);
}

/** Completion clock label ("done at 14:32", or "done Mon 14:32" on an earlier day). */
export function formatDoneAt(completedAt: string | null, now = new Date()): string {
  if (!completedAt) return "done";
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return "done";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `done at ${hh}:${mm}`;
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  return `done ${day} ${hh}:${mm}`;
}

export type DelegateStreamHandle = {
  readonly done: Promise<unknown>;
  readonly stop: () => void;
};

export type DelegateSocket = {
  stream<T>(tag: string, payload: unknown, onChunk: (value: T) => void): DelegateStreamHandle;
};

export type ShellConfig = {
  readonly shellThreadFamilies?: boolean;
  readonly shellOlderSettled?: boolean;
};

export type ShellSnapshot<P = unknown, T extends RawDelegateThread = RawDelegateThread> = {
  readonly projects: P[];
  readonly threads: T[];
};

type ShellChunk<P = unknown, T extends RawDelegateThread = RawDelegateThread> =
  | { readonly kind: "snapshot"; readonly snapshot?: ShellSnapshot<P, T> }
  | { readonly kind: "thread.updated"; readonly location?: string; readonly thread?: T }
  | { readonly kind: "thread.removed"; readonly threadId?: string };

type ChildThreadSnapshot = {
  readonly thread?: RawDelegateThread;
  readonly runs?: (RawRun & { readonly id: string })[];
  readonly turnItems?: RawTurnItem[];
  readonly visibleTurnItems?: { readonly item: RawTurnItem }[];
};

type ChildThreadChunk =
  | { readonly kind: "snapshot"; readonly projection?: ChildThreadSnapshot }
  | {
      readonly kind: "event";
      readonly event?: {
        readonly type: string;
        readonly payload: RawTurnItem &
          RawRun &
          RawDelegateThread & { readonly id?: string; readonly title?: string };
      };
    };

export type BrainProjectionForDelegates = {
  readonly thread?: {
    readonly pendingBackgroundTasks?: ReadonlyArray<RawPendingBackgroundTask> | null;
  };
  readonly visibleTurnItems?: ReadonlyArray<{ readonly item: RawSubagentTurnItem }>;
  readonly turnItems?: ReadonlyArray<RawSubagentTurnItem>;
};

export type BrowserDelegateTrackerOptions<P = unknown, T extends RawDelegateThread = RawDelegateThread> = {
  readonly brainThreadId: string;
  readonly titleOf: (threadId: string) => string | null;
  readonly linkOf: (threadId: string) => string | null;
  readonly onTitle: (threadId: string, title: string) => void;
  readonly onAgents: (agents: AgentRun[]) => void;
  readonly onShellSnapshot?: (snapshot: ShellSnapshot<P, T>) => void;
};

const isThreadLinkable = (threadId: string): boolean => !threadId.startsWith("turn-item:");

/**
 * Live delegate tracker for lalala.talk's browser harness: mirrors vite/t3bridge.mjs's shell and
 * child-thread tracking on a single multiplexed T3Socket, plus direct projection of brain-thread
 * `subagent` turn items and `pendingBackgroundTasks` so running/waiting workers appear immediately
 * and clear cleanly when finished.
 */
export function createBrowserDelegateTracker<
  P = unknown,
  T extends RawDelegateThread = RawDelegateThread,
>(options: BrowserDelegateTrackerOptions<P, T>) {
  let socket: DelegateSocket | null = null;
  let shellSub: DelegateStreamHandle | null = null;
  const delegates = new Map<string, DelegateStreamHandle>();
  const childWaiting = new Map<string, boolean>();
  const agents = new Map<string, AgentRun>();
  let pendingTaskIds = new Set<string>();
  let agentsLine = "[]";

  const linkContext: AgentLinkContext = {
    titleOf: options.titleOf,
    linkOf: (threadId) => (isThreadLinkable(threadId) ? options.linkOf(threadId) : null),
  };

  const view = () => sortAgents(agents.values());

  const emitAgents = () => {
    const list = view();
    const line = JSON.stringify(list);
    if (line === agentsLine) return;
    agentsLine = line;
    options.onAgents(list);
  };

  const stopChild = (threadId: string) => {
    const sub = delegates.get(threadId);
    if (sub !== undefined) {
      delegates.delete(threadId);
      sub.stop();
    }
    childWaiting.delete(threadId);
  };

  const followChild = (link: DelegateSocket, threadId: string, activeRunId?: string | null) => {
    if (socket !== link || !isThreadLinkable(threadId) || delegates.has(threadId)) return;
    const takeItem = (item: RawTurnItem | null | undefined, runId?: string | null) => {
      const existing = agents.get(threadId);
      if (!existing || !item) return;
      const updated = projectDelegateTurnItem(existing, item, runId);
      if (updated !== existing) {
        agents.set(threadId, updated);
        emitAgents();
      }
    };
    const takeRun = (run: RawRun | null | undefined, waiting: boolean) => {
      const existing = agents.get(threadId);
      if (!existing || !run) return;
      const updated = projectDelegateRun(existing, run, undefined, { threadWaiting: waiting });
      if (updated !== existing) {
        agents.set(threadId, updated);
        emitAgents();
      }
    };

    const sub = link.stream<ChildThreadChunk>(
      "orchestration.subscribeThread",
      { threadId, acceptBoundedSnapshot: true },
      (chunk) => {
        if (socket !== link || delegates.get(threadId) !== sub) return;
        if (chunk.kind === "snapshot" && chunk.projection) {
          const proj = chunk.projection;
          const projThread = proj.thread;
          if (projThread && typeof projThread.title === "string" && projThread.title.trim() !== "") {
            options.onTitle(threadId, projThread.title);
          }
          const waiting = isShellThreadWaiting(projThread);
          childWaiting.set(threadId, waiting);
          if (projThread) {
            agents.set(
              threadId,
              projectDelegateShell(
                agents.get(threadId),
                { ...projThread, id: threadId },
                linkContext.linkOf(threadId),
              ),
            );
          }
          const runId = projThread?.activeRunId ?? activeRunId ?? null;
          const activeRun =
            proj.runs?.find((run) => run.id === runId) ??
            proj.runs?.findLast((run) => isActiveAgent({ status: normalizeRunStatus(run.status) })) ??
            proj.runs?.at(-1);
          if (activeRun) takeRun(activeRun, waiting);
          const items =
            proj.turnItems ?? proj.visibleTurnItems?.map((row) => row.item) ?? [];
          for (const item of items) takeItem(item, runId);
          const current = agents.get(threadId);
          if (current && !isActiveAgent(current) && !isShellThreadActive(projThread)) {
            stopChild(threadId);
          }
          emitAgents();
        } else if (chunk.kind === "event" && chunk.event) {
          const { type, payload } = chunk.event;
          if (type === "turn-item.updated") {
            takeItem(payload);
          } else if (type === "run.created" || type === "run.updated") {
            const waiting = childWaiting.get(threadId) === true;
            takeRun(payload, waiting);
          } else if (type === "thread.updated") {
            if (typeof payload?.title === "string" && payload.title.trim() !== "") {
              options.onTitle(threadId, payload.title);
            }
            const waiting = isShellThreadWaiting(payload);
            if (
              payload.pendingBackgroundTasks !== undefined ||
              payload.pendingRuntimeRequest !== undefined ||
              payload.status !== undefined
            ) {
              childWaiting.set(threadId, waiting);
            }
            const existing = agents.get(threadId);
            if (existing) {
              const hasLifecycle =
                payload.activeRunId !== undefined ||
                payload.status !== undefined ||
                payload.pendingBackgroundTasks !== undefined ||
                payload.pendingRuntimeRequest !== undefined ||
                payload.latestRunStatus !== undefined;
              if (hasLifecycle) {
                const updated = projectDelegateShell(
                  existing,
                  { ...payload, id: threadId },
                  linkContext.linkOf(threadId),
                );
                agents.set(threadId, updated);
                if (!isActiveAgent(updated)) stopChild(threadId);
                emitAgents();
              } else if (typeof payload.title === "string" && payload.title !== existing.title) {
                agents.set(threadId, { ...existing, title: payload.title });
                emitAgents();
              }
            }
          }
        }
      },
    );
    delegates.set(threadId, sub);
    sub.done.catch(() => {}).finally(() => {
      if (delegates.get(threadId) === sub) {
        delegates.delete(threadId);
        childWaiting.delete(threadId);
      }
    });
  };

  const takeShellThread = (link: DelegateSocket, thread: RawDelegateThread) => {
    if (socket !== link) return;
    if (typeof thread.title === "string" && thread.title.trim() !== "") {
      options.onTitle(thread.id, thread.title);
    }
    const isDelegate = isBrainDelegateThread(thread, options.brainThreadId);
    const active = isDelegate && isShellThreadActive(thread);
    if (isDelegate || agents.has(thread.id)) {
      const projected = projectDelegateShell(
        agents.get(thread.id),
        thread,
        linkContext.linkOf(thread.id),
      );
      agents.set(thread.id, projected);
      emitAgents();
    }
    if (active) followChild(link, thread.id, thread.activeRunId);
    else stopChild(thread.id);
  };

  const syncPendingTasks = (
    link: DelegateSocket,
    tasks: ReadonlyArray<RawPendingBackgroundTask> | null | undefined,
    completeMissing: boolean,
  ) => {
    if (!Array.isArray(tasks)) return;
    const { agents: nextAgents, activeIds } = projectBrainPendingTasks(agents, tasks, linkContext);
    agents.clear();
    for (const [id, agent] of nextAgents) agents.set(id, agent);

    if (completeMissing) {
      for (const prevId of pendingTaskIds) {
        if (activeIds.has(prevId)) continue;
        const existing = agents.get(prevId);
        if (existing && isActiveAgent(existing)) {
          const nowIso = new Date().toISOString();
          agents.set(prevId, {
            ...existing,
            status: "completed",
            completedAt: nowIso,
            updatedAt: nowIso,
          });
        }
        stopChild(prevId);
      }
    }
    pendingTaskIds = activeIds;
    for (const id of activeIds) followChild(link, id);
    emitAgents();
  };

  const takeSubagentItem = (link: DelegateSocket, item: RawSubagentTurnItem) => {
    if (socket !== link || item.type !== "subagent") return;
    const threadId = subagentThreadIdOf(item) ?? (typeof item.id === "string" ? item.id : null);
    if (!threadId) return;
    if (typeof item.title === "string" && item.title.trim() !== "") {
      options.onTitle(threadId, item.title);
    }
    const existing = agents.get(threadId);
    const projected = projectBrainSubagentItem(existing, item, linkContext);
    if (!projected) return;
    agents.set(threadId, projected);
    if (isActiveAgent(projected)) followChild(link, threadId);
    else stopChild(threadId);
  };

  return {
    view,

    attach(link: DelegateSocket) {
      if (socket === link) return;
      if (socket !== null) this.reset();
      socket = link;
    },

    /** Starts the live `orchestration.subscribeShell` stream on `link`. */
    startShell(link: DelegateSocket, config?: ShellConfig) {
      this.attach(link);
      shellSub?.stop();
      const families = config?.shellThreadFamilies === true;
      const payload = {
        ...(families ? { omitIdleSubagents: true } : {}),
        ...(families && config?.shellOlderSettled === true ? { omitOlderSettled: true } : {}),
      };
      const sub = link.stream<ShellChunk<P, T>>("orchestration.subscribeShell", payload, (chunk) => {
        if (socket !== link || shellSub !== sub) return;
        if (chunk.kind === "snapshot" && chunk.snapshot) {
          for (const thread of chunk.snapshot.threads ?? []) takeShellThread(link, thread);
          options.onShellSnapshot?.(chunk.snapshot);
          emitAgents();
        } else if (chunk.kind === "thread.updated" && chunk.thread) {
          const raw = chunk.thread;
          const thread: RawDelegateThread =
            chunk.location === "active"
              ? raw
              : {
                  id: raw.id,
                  ...(typeof raw.title === "string" ? { title: raw.title } : {}),
                  ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
                  ...(typeof raw.latestRunStatus === "string"
                    ? { latestRunStatus: raw.latestRunStatus }
                    : {}),
                  activeRunId: null,
                  status: null,
                  pendingBackgroundTasks: [],
                  pendingRuntimeRequest: null,
                };
          takeShellThread(link, thread);
        } else if (chunk.kind === "thread.removed" && typeof chunk.threadId === "string") {
          takeShellThread(link, {
            id: chunk.threadId,
            activeRunId: null,
            status: null,
            pendingBackgroundTasks: [],
            pendingRuntimeRequest: null,
          });
        }
      });
      shellSub = sub;
      sub.done.catch(() => {}).finally(() => {
        if (shellSub === sub) shellSub = null;
      });
    },

    /** Projects the brain thread's snapshot (`subagent` items + `pendingBackgroundTasks`). */
    takeBrainSnapshot(link: DelegateSocket, projection: BrainProjectionForDelegates) {
      this.attach(link);
      const items =
        projection.turnItems ?? projection.visibleTurnItems?.map((row) => row.item) ?? [];
      for (const item of items) {
        if (item?.type === "subagent") takeSubagentItem(link, item);
      }
      syncPendingTasks(link, projection.thread?.pendingBackgroundTasks, false);
      emitAgents();
    },

    /** Projects a live brain `turn-item.updated` event when it is a `subagent` item. */
    takeBrainTurnItem(link: DelegateSocket, item: RawSubagentTurnItem) {
      if (socket !== link || item.type !== "subagent") return;
      takeSubagentItem(link, item);
      emitAgents();
    },

    /** Projects a live brain `thread.updated` event (syncing `pendingBackgroundTasks`). */
    takeBrainThreadUpdated(
      link: DelegateSocket,
      thread: { readonly pendingBackgroundTasks?: ReadonlyArray<RawPendingBackgroundTask> | null },
    ) {
      if (socket !== link) return;
      syncPendingTasks(link, thread.pendingBackgroundTasks, true);
    },

    /** Backfills finished runs and `[about: card]` links from brain `delegated_task` notifications. */
    takeBrainNotifications(rows: Iterable<BrainNotificationRow>) {
      const next = projectBrainNotificationAgents(agents, rows, linkContext);
      agents.clear();
      for (const [id, agent] of next) {
        agents.set(id, agent);
        if (!isActiveAgent(agent)) stopChild(id);
      }
      emitAgents();
    },

    /** Backfills clickable links and titles once `server.getConfig` / shell has loaded. */
    refreshLinks() {
      let changed = false;
      for (const [id, agent] of agents) {
        const nextLink = linkContext.linkOf(id) ?? agent.link;
        const nextTitle = linkContext.titleOf(id) ?? agent.title;
        if (nextLink !== agent.link || nextTitle !== agent.title) {
          agents.set(id, { ...agent, link: nextLink, title: nextTitle });
          changed = true;
        }
      }
      if (changed) emitAgents();
    },

    /** Stops all active shell/child subscriptions and clears tracked agent runs. */
    reset() {
      socket = null;
      shellSub?.stop();
      shellSub = null;
      for (const sub of delegates.values()) sub.stop();
      delegates.clear();
      childWaiting.clear();
      agents.clear();
      pendingTaskIds.clear();
      agentsLine = "[]";
    },
  };
}
