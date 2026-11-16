/**
 * The away inbox (Labs): every result from outside the conversation that reaches the brain thread,
 * kept until the user has heard it. Both harnesses run this on the brain thread's rows (the app's
 * server always, vite/t3bridge.mjs; lalala.talk's tab while it is open), so it imports nothing.
 *
 * What counts comes from T3's own fields, never from the text: a message another thread sent
 * (`senderThreadId`), a scheduled task's turn (`scheduledTaskId`), a delegated task's end (a
 * `delegated_task` notification). A message from another agent session reaches the provider
 * directly, so T3 shows only the `background_task` notification that woke the run: that run counts
 * when the brain's reply marks something from outside (`[new topic]`). One item per run at most.
 * The one-line summary is what the brain wrote back in that run.
 */

export type InboxKind = "delegated" | "message" | "scheduled" | "session";

/** What a trigger row carries (slim rows keep only this of the T3 item). */
export type InboxTrigger = {
  readonly kind: InboxKind;
  /** The thread it came from: the sender, or the delegated task's own thread. */
  readonly threadId: string | null;
  readonly outcome: string | null;
  /** T3's own line (a notification's summary) or the start of the message sent. */
  readonly lead: string;
};

export type InboxItem = {
  /** Short, for the brain's `[heard: …]` tag. */
  readonly id: string;
  /** The T3 turn item that brought it. */
  readonly source: string;
  readonly at: string;
  readonly kind: InboxKind;
  readonly outcome: string | null;
  /** The thread's title, or what kind of thing it was. */
  readonly from: string;
  readonly threadId: string | null;
  readonly link: string | null;
  readonly summary: string;
  /** The card the brain said it is about (`[about: <id>]`). */
  readonly card: string | null;
  /** The brain's reply in the run it woke, whose playback means the user heard it. */
  readonly replyId: string | null;
  readonly heard: boolean;
  readonly heardAt: string | null;
};

export type Inbox = {
  readonly items: ReadonlyArray<InboxItem>;
  /** When the last digest went out (app only). */
  readonly digestAt: string | null;
};

export type InboxChange =
  | { readonly heard: ReadonlyArray<string> | "all" }
  | { readonly unheard: ReadonlyArray<string> };

export const EMPTY_INBOX: Inbox = { items: [], digestAt: null };
const MAX_ITEMS = 200;
const LEAD_CHARS = 200;
const SUMMARY_CHARS = 280;

type RawItem = {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly senderThreadId?: string;
  readonly scheduledTaskId?: string;
  readonly source?: { readonly kind?: string; readonly childThreadId?: string };
  readonly outcome?: string;
  readonly summary?: string;
};

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The trigger a raw T3 turn item is, or null: for the bridges' slim rows. */
export function inboxTrigger(item: RawItem): InboxTrigger | null {
  if (item.type === "user_message" && item.senderThreadId) {
    return {
      kind: "message",
      threadId: item.senderThreadId,
      outcome: null,
      lead: oneLine(item.text ?? "", LEAD_CHARS),
    };
  }
  if (item.type === "user_message" && item.scheduledTaskId) {
    return { kind: "scheduled", threadId: null, outcome: null, lead: oneLine(item.text ?? "", LEAD_CHARS) };
  }
  if (
    item.type === "notification" &&
    item.source?.kind === "delegated_task" &&
    (item.outcome === "completed" || item.outcome === "failed" || item.outcome === "cancelled")
  ) {
    return {
      kind: "delegated",
      threadId: item.source.childThreadId ?? null,
      outcome: item.outcome,
      lead: oneLine(item.summary ?? "", LEAD_CHARS),
    };
  }
  if (item.type === "notification" && item.source?.kind === "background_task") {
    return { kind: "session", threadId: null, outcome: null, lead: "" };
  }
  return null;
}

/** A row as both bridges slim it, with the fields this reads. */
export type InboxRow = {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly parentItemId: string | null;
    readonly startedAt: string | null;
    readonly updatedAt: string;
    readonly runId?: string | null;
    readonly trigger?: InboxTrigger | null;
  };
};

/** Five base-36 characters from the turn item id: stable, and short enough to say in a tag. */
export function shortId(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 36 ** 5).toString(36).padStart(5, "0");
}

// lalala's own reply tags (VoiceHost, brainCards, follow): never spoken, so never in a summary.
const CONTROL_TAG = /\[(?:new topic|about|focus|tidy|streamer|heard|card)\b[^\]]*\]/gi;
const NEW_TOPIC = /\[new topic\]/i;
const BARE_HEARD = /\[heard\]/i;

type Said = { summary: string | null; card: string | null; topic: boolean; label: string | null };

/** What the brain said about it: its reply's `[new topic]` part (or all of it), tags out. */
function replySummary(text: string): Said {
  const parts = text.split(NEW_TOPIC);
  const part = parts.length > 1 ? parts.at(-1)! : text;
  const card = /\[about:\s*([^\]]+)\]/i.exec(part)?.[1]?.replace(/[`"]/g, "").trim() || null;
  const said = oneLine(part.replace(CONTROL_TAG, " "), SUMMARY_CHARS);
  // The label brain.md has every outside result open with ("k20c: …"), as speech.ts reads it.
  const label = /^([^:.!?]{1,60}):\s/.exec(said)?.[1]?.trim() ?? null;
  return {
    summary: said === "" || /^\.+$/.test(said) ? null : said,
    card,
    topic: parts.length > 1,
    label,
  };
}
const NOTHING_SAID: Said = { summary: null, card: null, topic: false, label: null };

export type InboxContext = {
  /** A thread's title, if the harness knows it. */
  readonly titleOf: (threadId: string) => string | null;
  /** Where the user opens that thread in T3 Code, if the harness can say. */
  readonly linkOf: (threadId: string) => string | null;
};

const FALLBACK_FROM: Record<InboxKind, string> = {
  delegated: "Delegated task",
  message: "Another thread",
  scheduled: "Scheduled task",
  session: "Another session",
};

const sameItem = (a: InboxItem, b: InboxItem) =>
  a.summary === b.summary &&
  a.card === b.card &&
  a.replyId === b.replyId &&
  a.from === b.from &&
  a.link === b.link;

/**
 * The inbox with these rows taken in: new results added (unheard), and the summary of ones still in
 * view brought up to date as the brain's reply finishes. The same inbox back when nothing changed.
 */
export function captureInbox(
  inbox: Inbox,
  rows: Iterable<InboxRow>,
  context: InboxContext,
): Inbox {
  const replies = new Map<string, InboxRow["item"][]>();
  // Per run, its triggers in order; a run with none of its own (a user's turn) keeps each alone.
  const runs = new Map<string, InboxRow["item"][]>();
  for (const { item } of rows) {
    if (item.trigger) {
      const run = item.runId ?? item.id;
      runs.set(run, [...(runs.get(run) ?? []), item]);
    } else if (item.type === "assistant_message" && item.parentItemId === null && item.runId) {
      replies.set(item.runId, [...(replies.get(item.runId) ?? []), item]);
    }
  }
  if (runs.size === 0) return inbox;
  const bySource = new Map(inbox.items.map((entry) => [entry.source, entry]));
  let changed = false;
  for (const [run, all] of runs) {
    const reply = replies
      .get(run)
      ?.findLast((entry) => !entry.streaming && entry.text.trim() !== "");
    // A session's message only counts when the brain marked it as news; its wake beside a real
    // trigger (or a second wake in the same run) is the same result, not another one.
    const named = all.filter((item) => item.trigger!.kind !== "session");
    const said = reply ? replySummary(reply.text) : NOTHING_SAID;
    const taken = named.length > 0 ? named : said.topic ? all.slice(0, 1) : [];
    for (const item of taken) {
      const trigger = item.trigger!;
      // A run woken by one result is the brain's word on it; one that took in several is about none alone.
      const own = taken.length === 1;
      const words = own ? said : NOTHING_SAID;
      // The brain's bare `[heard]` in its own run: nothing in it for the user (brain-inbox.md).
      const dismissed = own && reply !== undefined && BARE_HEARD.test(reply.text);
      const was = bySource.get(item.id);
      const at = item.startedAt ?? item.updatedAt;
      // A delegated task's end after its thread already sent the result, which the brain let pass
      // without a word: the same result twice.
      if (
        !was &&
        trigger.kind === "delegated" &&
        words.summary === null &&
        [...bySource.values()].some(
          (entry) =>
            entry.kind === "message" &&
            entry.threadId === trigger.threadId &&
            Date.parse(entry.at) <= Date.parse(at),
        )
      ) {
        continue;
      }
      const next: InboxItem = {
        id: was?.id ?? shortId(item.id),
        source: item.id,
        at: was?.at ?? at,
        kind: trigger.kind,
        outcome: trigger.outcome,
        from:
          (trigger.threadId ? context.titleOf(trigger.threadId) : null) ??
          words.label ??
          was?.from ??
          FALLBACK_FROM[trigger.kind],
        threadId: trigger.threadId,
        link: (trigger.threadId ? context.linkOf(trigger.threadId) : null) ?? was?.link ?? null,
        summary: words.summary ?? was?.summary ?? (trigger.lead || FALLBACK_FROM[trigger.kind]),
        card: words.card ?? was?.card ?? null,
        replyId: (own ? reply?.id : undefined) ?? was?.replyId ?? null,
        heard: (was?.heard ?? false) || dismissed,
        heardAt: was?.heardAt ?? (dismissed ? (reply?.updatedAt ?? null) : null),
      };
      if (was && sameItem(was, next) && was.heard === next.heard) continue;
      bySource.set(item.id, next);
      changed = true;
    }
  }
  if (!changed) return inbox;
  const items = [...bySource.values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_ITEMS);
  return { ...inbox, items };
}

/** The inbox with a mark applied (from the panel, the brain's tag, or playback). */
export function applyInboxChange(inbox: Inbox, change: InboxChange, now = new Date()): Inbox {
  const at = now.toISOString();
  let changed = false;
  const items = inbox.items.map((item) => {
    if ("heard" in change) {
      if (item.heard || (change.heard !== "all" && !change.heard.includes(item.id))) return item;
      changed = true;
      return { ...item, heard: true, heardAt: at };
    }
    if (!item.heard || !change.unheard.includes(item.id)) return item;
    changed = true;
    return { ...item, heard: false, heardAt: null };
  });
  return changed ? { ...inbox, items } : inbox;
}

/** Two copies of one inbox (two tabs, a file another device wrote): every item, heard wins. */
export function mergeInbox(a: Inbox, b: Inbox): Inbox {
  const bySource = new Map(a.items.map((item) => [item.source, item]));
  for (const item of b.items) {
    const was = bySource.get(item.source);
    if (!was) bySource.set(item.source, item);
    else if (item.heard && !was.heard) bySource.set(item.source, { ...was, heard: true, heardAt: item.heardAt });
  }
  const digests = [a.digestAt, b.digestAt].filter((at): at is string => at !== null).sort();
  return {
    items: [...bySource.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).slice(-MAX_ITEMS),
    digestAt: digests.at(-1) ?? null,
  };
}

const ids = (value: unknown) =>
  Array.isArray(value) && value.every((id) => typeof id === "string") ? (value as string[]) : null;

/** A mark sent over the network, or null when it isn't one. */
export function parseInboxChange(value: unknown): InboxChange | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { heard?: unknown; unheard?: unknown };
  if (raw.heard === "all") return { heard: "all" };
  const heard = ids(raw.heard);
  if (heard) return { heard };
  const unheard = ids(raw.unheard);
  return unheard ? { unheard } : null;
}

/** An inbox read from a file or the network, or the empty one. */
export function parseInbox(value: unknown): Inbox {
  if (typeof value !== "object" || value === null) return EMPTY_INBOX;
  const raw = value as { items?: unknown; digestAt?: unknown };
  const items = Array.isArray(raw.items)
    ? raw.items.filter(
        (item): item is InboxItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as InboxItem).id === "string" &&
          typeof (item as InboxItem).source === "string" &&
          typeof (item as InboxItem).at === "string" &&
          typeof (item as InboxItem).summary === "string",
      )
    : [];
  return { items, digestAt: typeof raw.digestAt === "string" ? raw.digestAt : null };
}

export const unreadItems = (inbox: Inbox) => inbox.items.filter((item) => !item.heard);
