// lalala.talk's harness: the tab itself follows the brain thread on the visitor's own T3 Code
// (paired in the settings' Connection section) and sends turns to it, speaking the same events as vite/t3bridge.mjs.
import type { HarnessAdapter } from "..";
import {
  type RawDelegateThread,
  createBrowserDelegateTracker,
} from "../../agents/model";
import {
  type Inbox,
  type InboxChange,
  applyInboxChange,
  captureInbox,
  inboxTrigger,
  mergeInbox,
  parseInbox,
} from "../../inbox/capture";
import { isLocalOrigin } from "../../pairing";
import {
  ACTIVE_RUN,
  type RawMessage,
  type RawRun,
  type RawUsage,
  type SlimCompactionItem,
  type SlimRun,
  collectCompactionItems,
  deriveBrainContext,
  isCompactionMessage,
  slimCompactionItem,
  slimRun,
} from "./compaction";
import {
  type Project,
  SOCKET_CLOSED,
  T3Socket,
  localNetworkPermission,
  localNetworkProblem,
  readBrainThread,
  readSession,
  readShell,
  uuid,
} from "./t3";

const MAX_ROWS = 400;
const STEP_TIMEOUT_MS = 10_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
// How long a turn waits for a dropped link to come back before it fails.
const SEND_WAIT_MS = 15_000;

type ProviderTurn = { providerThreadId: string; tokenUsage?: RawUsage };

type Item = {
  id: string;
  type: string;
  text?: string;
  streaming?: boolean;
  parentItemId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  runId?: string | null;
  status?: string;
  title?: string | null;
  summary?: string;
  label?: string | null;
  childThreadId?: string | null;
  subagentThreadId?: string | null;
  targetThreadId?: string | null;
  source?: { kind?: string; childThreadId?: string };
  retry?: unknown;
  context?: { records?: { contextId?: string }[] };
};
type Thread = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  runtimeMode: string;
  interactionMode: string;
  activeProviderThreadId?: string | null;
};

// The page only reads these fields (VoiceHost, brief.ts), as from the app's bridge.
const slim = (visibility: string, item: Item) => ({
  visibility,
  item: {
    id: item.id,
    type: item.type,
    text: item.type === "assistant_message" ? (item.text ?? "") : "",
    streaming: item.streaming === true,
    parentItemId: item.parentItemId ?? null,
    briefId:
      item.type === "user_message"
        ? (item.context?.records?.find((record) => record.contextId?.startsWith("lalala-brief-"))
            ?.contextId ?? null)
        : null,
    startedAt: item.startedAt ?? null,
    updatedAt: item.updatedAt ?? item.startedAt ?? new Date(0).toISOString(),
    // The away inbox's (src/voice/inbox/capture.ts): which run, and what came in from outside.
    runId: item.runId ?? null,
    trigger: inboxTrigger(item),
    retrying: item.type === "error" && item.status === "running" && item.retry != null,
  },
});
type Row = ReturnType<typeof slim>;

// The away inbox: here in this browser, and in the brain's project so the brain (and the user's
// other browsers) read the same one. No server keeps it: it fills from the thread while a tab is open.
const INBOX_FILE = ".lalala/inbox.json";
const INBOX_WRITE_MS = 2_000;
const inboxKey = (threadId: string) => `lalala:inbox:${threadId}`;
function readLocalInbox(threadId: string): Inbox {
  try {
    return parseInbox(JSON.parse(localStorage.getItem(inboxKey(threadId)) ?? "null"));
  } catch {
    return parseInbox(null);
  }
}

/** The paired T3 and its brain thread, or null until the settings' Connection section has both. */
export function browserBrain() {
  const session = readSession();
  const threadId = session && readBrainThread(session.origin);
  return session && threadId ? { session, threadId } : null;
}

export function browserHarness(): HarnessAdapter {
  const listeners = new Set<(event: unknown) => void>();
  const state = {
    connected: false,
    error: null as string | null,
    thread: null as Thread | null,
    rows: new Map<string, Row>(),
    runs: new Map<string, SlimRun>(),
    // The brain's context for the page's compact-on-return (src/voice/brainCompaction.ts).
    usage: null as RawUsage | null,
    claude: false,
    compactions: new Set<string>(),
    compactionItems: new Map<string, SlimCompactionItem>(),
    contextLine: "null",
    titles: new Map<string, string>(),
    environmentId: null as string | null,
    inbox: parseInbox(null),
  };
  let socket: T3Socket | null = null;
  let started = false;
  let connecting = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let permission: PermissionStatus | null = null;
  const waiters = new Set<() => void>();

  const active = () => [...state.runs.values()].some((run) => ACTIVE_RUN.has(run.status));
  const context = () => deriveBrainContext(state);
  // Newest report of the thread's active provider session.
  const takeUsage = (turn: ProviderTurn) => {
    if (turn.tokenUsage === undefined) return;
    if (turn.providerThreadId !== state.thread?.activeProviderThreadId) return;
    if (
      state.usage !== null &&
      Date.parse(turn.tokenUsage.updatedAt) < Date.parse(state.usage.updatedAt)
    ) {
      return;
    }
    state.usage = turn.tokenUsage;
  };
  const brain = browserBrain();
  // VoiceHost matches the bridge's workspace with its config's; the thread is the whole workspace here.
  const workspaceRoot = brain ? `t3:${brain.threadId}` : null;
  if (brain) state.inbox = readLocalInbox(brain.threadId);
  const inboxView = () => ({ ...state.inbox, digest: false });
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event);
  };
  const inboxContext = {
    titleOf: (threadId: string) => state.titles.get(threadId) ?? null,
    linkOf: (threadId: string) =>
      brain && state.environmentId
        ? `${brain.session.origin}/${state.environmentId}/${encodeURIComponent(threadId)}`
        : null,
  };
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxRead = false;
  let shellProjects: Project[] | null = null;
  const setInbox = (next: Inbox) => {
    if (next === state.inbox || brain === null) return;
    state.inbox = next;
    try {
      localStorage.setItem(inboxKey(brain.threadId), JSON.stringify(next));
    } catch {
      // No storage: the project's file still has it.
    }
    emit({ type: "inbox", inbox: inboxView() });
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(() => void writeInbox(), INBOX_WRITE_MS);
  };
  // Read-merge-write: another browser may have written since; an item stays heard once it was.
  async function writeInbox() {
    if (!socket?.open) return;
    try {
      const link = socket;
      const root = await rootOf(link);
      const file = await link.request<{ contents: string; exists?: boolean }>("projects.readFile", {
        cwd: root,
        relativePath: INBOX_FILE,
        allowMissing: true,
      });
      const there = file.exists === false ? parseInbox(null) : parseInbox(JSON.parse(file.contents));
      const merged = mergeInbox(state.inbox, there);
      await link.request("projects.writeFile", {
        cwd: root,
        relativePath: INBOX_FILE,
        contents: JSON.stringify(merged, null, 1),
      });
      if (merged.items.length !== state.inbox.items.length) setInbox(merged);
    } catch {
      // The next change writes it again.
    }
  }
  const tracker = createBrowserDelegateTracker<Project, RawDelegateThread>({
    brainThreadId: brain?.threadId ?? "",
    titleOf: inboxContext.titleOf,
    linkOf: inboxContext.linkOf,
    onTitle: (threadId, title) => state.titles.set(threadId, title),
    onAgents: (agents) => emit({ type: "agents", agents }),
    onShellSnapshot: (snapshot) => {
      if (snapshot.projects.length > 0) shellProjects = snapshot.projects;
      if (inboxRead) takeInbox();
    },
  });
  const hello = () => ({
    type: "hello",
    connected: state.connected,
    error: state.error,
    workspaceRoot,
    shell: state.thread && { ...state.thread, active: active() },
    rows: [...state.rows.values()],
    context: context(),
    agents: tracker.view(),
    inbox: inboxView(),
  });
  // The first capture in this browser and project finds what the thread already holds: that came
  // before the inbox, so it is heard.
  const takeInbox = (seed = false) => {
    const next = captureInbox(state.inbox, state.rows.values(), inboxContext);
    setInbox(seed ? applyInboxChange(next, { heard: "all" }) : next);
  };
  // Once per connection: server config for links/shell flags, live shell stream for running
  // delegates and titles, and the project's away-inbox file.
  async function readInboxContext(link: T3Socket) {
    let config: {
      environment?: { environmentId?: string };
      shellThreadFamilies?: boolean;
      shellOlderSettled?: boolean;
    } | null = null;
    try {
      config = await link.request<{
        environment?: { environmentId?: string };
        shellThreadFamilies?: boolean;
        shellOlderSettled?: boolean;
      }>("server.getConfig", {});
      if (socket !== link) return;
      state.environmentId = config.environment?.environmentId ?? null;
      tracker.refreshLinks();
    } catch {
      // Links and shell flags are extras: still follow the shell stream below.
    }
    if (socket !== link) return;
    tracker.startShell(link, config ?? undefined);
    try {
      if (!inboxRead) {
        const contents = await rootOf(link).then((cwd) =>
          link.request<{ contents: string; exists?: boolean }>("projects.readFile", {
            cwd,
            relativePath: INBOX_FILE,
            allowMissing: true,
          }),
        );
        if (socket !== link) return;
        const there = contents.exists === false ? null : parseInbox(JSON.parse(contents.contents));
        inboxRead = true;
        if (there) setInbox(mergeInbox(state.inbox, there));
        return takeInbox(there === null && state.inbox.items.length === 0);
      }
    } catch {
      // The project's copy is an extra: items still come in under their kind.
    }
    if (socket !== link) return;
    inboxRead = true;
    takeInbox();
  }
  const emitContext = () => {
    const line = JSON.stringify(context());
    if (line === state.contextLine) return;
    state.contextLine = line;
    emit({ type: "context", context: JSON.parse(line) });
  };

  const fail = (message: string) => {
    state.connected = false;
    state.error = message;
    emit(hello());
  };

  // Retries until T3 answers again; Chrome granting local network access, the network coming back,
  // or the tab coming back into view retries right away.
  const later = () => {
    clearTimeout(retry);
    if (!started) return;
    retry = setTimeout(connect, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
    failures += 1;
  };
  const now = () => {
    if (!started || socket !== null || connecting) return;
    clearTimeout(retry);
    void connect();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") now();
  };

  async function connect() {
    if (brain === null) return fail("Not paired with T3 Code yet");
    if (connecting || socket !== null) return;
    connecting = true;
    try {
      // Only a plain-http T3 on this network needs Chrome's local network permission.
      if (isLocalOrigin(brain.session.origin)) {
        permission ??= await localNetworkPermission();
        if (permission) permission.onchange = now;
      }
      const problem = localNetworkProblem(permission);
      // Blocked in Chrome: nothing to try until the user allows it (onchange retries).
      if (permission?.state === "denied") return fail(problem!);
      if (problem) fail(problem);
      const next = new T3Socket(brain.session);
      // While Chrome's prompt may be up the request waits on it, so no timeout then.
      await next.connect(problem ? undefined : STEP_TIMEOUT_MS);
      if (!started) return next.close();
      socket = next;
      next.onClose = () => {
        socket = null;
        tracker.reset();
        // Closed on purpose (the last listener left): no reconnect.
        if (!started) return;
        fail("Reconnecting to T3 Code…");
        later();
      };
      next
        .stream<{ kind: string; projection?: never; event?: { type: string; payload: never } }>(
          "orchestration.subscribeThread",
          { threadId: brain.threadId, acceptBoundedSnapshot: true },
          (chunk) => {
            if (chunk.kind === "snapshot" && chunk.projection) {
              const projection = chunk.projection as {
                thread: Thread;
                runs: RawRun[];
                messages: RawMessage[];
                providerThreads: { id: string; driver: string }[];
                providerTurns: ProviderTurn[];
                visibleTurnItems: { visibility: string; item: Item }[];
              };
              state.thread = projection.thread;
              state.runs = new Map(projection.runs.map((run) => [run.id, slimRun(run)]));
              state.compactions = new Set(
                projection.messages.filter(isCompactionMessage).map((message) => message.id),
              );
              state.compactionItems = collectCompactionItems(projection.visibleTurnItems);
              state.claude =
                projection.providerThreads.find(
                  (thread) => thread.id === projection.thread.activeProviderThreadId,
                )?.driver === "claudeAgent";
              state.usage = null;
              for (const turn of projection.providerTurns) takeUsage(turn);
              state.contextLine = JSON.stringify(context());
              state.rows = new Map(
                projection.visibleTurnItems
                  .slice(-MAX_ROWS)
                  .map((row) => [row.item.id, slim(row.visibility, row.item)]),
              );
              state.connected = true;
              state.error = null;
              failures = 0;
              void readInboxContext(next);
              emit(hello());
              for (const wake of waiters) wake();
              waiters.clear();
            } else if (chunk.kind === "event" && chunk.event) {
              const { type, payload } = chunk.event as {
                type: string;
                payload: Item &
                  RawRun &
                  ProviderTurn &
                  RawMessage &
                  Partial<Thread> & { threadId?: string; driver?: string };
              };
              if (type === "turn-item.updated" && payload.threadId === brain.threadId) {
                const row = slim("local", payload);
                state.rows.delete(row.item.id);
                state.rows.set(row.item.id, row);
                while (state.rows.size > MAX_ROWS) state.rows.delete(state.rows.keys().next().value!);
                emit({ type: "row", row });
                if (payload.type === "compaction") {
                  state.compactionItems.set(payload.id, slimCompactionItem(payload));
                  emitContext();
                }
                // Before the project's copy is in, the first capture (and its seed) waits for it.
                if (
                  inboxRead &&
                  (row.item.trigger !== null || (row.item.type === "assistant_message" && !row.item.streaming))
                ) {
                  takeInbox();
                }
              } else if (type === "run.created" || type === "run.updated") {
                const was = active();
                state.runs.set(payload.id, slimRun(payload));
                if (active() !== was) emit({ type: "active", value: active() });
                emitContext();
              } else if (type === "provider-turn.updated") {
                takeUsage(payload);
                emitContext();
              } else if (type === "provider-thread.updated") {
                if (payload.id === state.thread?.activeProviderThreadId) {
                  state.claude = payload.driver === "claudeAgent";
                  emitContext();
                }
              } else if (type === "message.updated" && isCompactionMessage(payload)) {
                state.compactions.add(payload.id);
                emitContext();
              } else if (type === "thread.updated" && payload.id === brain.threadId) {
                if (state.thread) state.thread = { ...state.thread, ...payload };
              }
            }
          },
        )
        .done.catch((error: Error) => {
          if (socket !== next) return;
          // The thread's stream ended with the socket still up: start over on a fresh one.
          socket = null;
          tracker.reset();
          next.close();
          fail(`T3: ${error.message}`);
          later();
        });
    } catch (error) {
      fail((error as Error).message);
      later();
    } finally {
      connecting = false;
    }
  }

  /** The socket once the thread's snapshot is in, waiting a while for a dropped link to return. */
  async function linked() {
    if (socket?.open && state.connected) return socket;
    now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SEND_WAIT_MS);
      waiters.add(() => resolve(clearTimeout(timer)));
    });
    if (socket?.open && state.connected) return socket;
    throw new Error(state.error ?? "T3 Code is not answering");
  }

  // The brain thread's project folder on the paired machine, for its card files.
  let projectRoot: Promise<string> | null = null;
  const rootOf = (link: T3Socket) =>
    (projectRoot ??= (
      shellProjects !== null ? Promise.resolve({ projects: shellProjects }) : readShell(link)
    ).then(({ projects }) => {
      const root = projects.find((p) => p.id === state.thread?.projectId)?.workspaceRoot;
      if (root === undefined) throw new Error("The voice thread's project is gone");
      return root;
    })).catch((error: Error) => {
      projectRoot = null;
      throw error;
    });

  return {
    config: async () => (workspaceRoot === null ? null : { workspaceRoot, model: null }),
    async readFile(relativePath) {
      const link = await linked();
      const file = await link.request<{ contents: string; truncated: boolean; exists?: boolean }>(
        "projects.readFile",
        { cwd: await rootOf(link), relativePath, allowMissing: true },
      );
      return file.exists === false || file.truncated ? null : file.contents;
    },
    async writeFile(relativePath, contents) {
      const link = await linked();
      await link.request("projects.writeFile", { cwd: await rootOf(link), relativePath, contents });
    },
    async inbox(change: InboxChange | { readonly call: true }) {
      if ("call" in change) return;
      setInbox(applyInboxChange(state.inbox, change));
    },
    async settle() {
      if (brain === null) throw new Error("Not paired with T3 Code yet");
      const link = await linked();
      await link.dispatch({
        type: "thread.settle",
        threadId: brain.threadId,
      });
    },
    async run(command) {
      if (brain === null) throw new Error("Not paired with T3 Code yet");
      const link = await linked();
      const target = { threadId: brain.threadId, terminalId: "lalala-speech" };
      await link.request("terminal.open", { ...target, cwd: await rootOf(link) });
      await link.request("terminal.write", { ...target, data: `${command}\r` });
    },
    events(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        failures = 0;
        window.addEventListener("online", now);
        document.addEventListener("visibilitychange", onVisible);
        void connect();
      } else listener(hello());
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        clearTimeout(retry);
        started = false;
        window.removeEventListener("online", now);
        document.removeEventListener("visibilitychange", onVisible);
        if (permission) permission.onchange = null;
        tracker.reset();
        socket?.close();
        socket = null;
      };
    },
    async send(command) {
      const { threadId, message } = command as {
        threadId: string;
        message: {
          messageId: string;
          text: string;
          context?: unknown;
          attachments?: { dataUrl?: string }[];
          idleCompaction?: string;
        };
      };
      if (brain === null || threadId !== brain.threadId) throw new Error("Not the brain thread");
      // Two devices back at once both ask; one compaction is enough.
      if (message.idleCompaction !== undefined && context()?.compacting) return null;
      const uploads = (message.attachments ?? []).filter((a) => typeof a.dataUrl === "string");
      // One id for both tries, so T3 runs the turn once even if the first try did reach it.
      const commandId = uuid();
      const deliver = async () => {
        const link = await linked();
        const attachments =
          uploads.length === 0
            ? []
            : (
                await link.request<{ attachments: unknown[] }>("assets.persistChatAttachments", {
                  threadId,
                  messageId: message.messageId,
                  attachments: uploads,
                })
              ).attachments;
        return link.dispatch({
          commandId,
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: message.messageId,
          text: message.text,
          ...(message.context === undefined ? {} : { context: message.context }),
          attachments,
          ...(message.idleCompaction === undefined ? {} : { idleCompaction: message.idleCompaction }),
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        });
      };
      // The link dropped under this turn: once it is back, send it again.
      return deliver().catch((error: Error) => {
        if (error.message !== SOCKET_CLOSED) throw error;
        return deliver();
      });
    },
  };
}
