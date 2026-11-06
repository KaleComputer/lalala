// lalala.talk's harness: the tab itself follows the brain thread on the visitor's own T3 Code
// (paired in the settings' Connection section) and sends turns to it, speaking the same events as vite/t3bridge.mjs.
import type { HarnessAdapter } from "..";
import {
  SOCKET_CLOSED,
  T3Socket,
  localNetworkPermission,
  localNetworkProblem,
  readBrainThread,
  readSession,
  uuid,
} from "./t3";

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const MAX_ROWS = 400;
const STEP_TIMEOUT_MS = 10_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
// How long a turn waits for a dropped link to come back before it fails.
const SEND_WAIT_MS = 15_000;

type Item = {
  id: string;
  type: string;
  text?: string;
  streaming?: boolean;
  parentItemId?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
};
type Thread = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  runtimeMode: string;
  interactionMode: string;
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
    startedAt: item.startedAt ?? null,
    updatedAt: item.updatedAt ?? item.startedAt ?? new Date(0).toISOString(),
  },
});
type Row = ReturnType<typeof slim>;

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
    runs: new Map<string, string>(),
  };
  let socket: T3Socket | null = null;
  let started = false;
  let connecting = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let permission: PermissionStatus | null = null;
  const waiters = new Set<() => void>();

  const active = () => [...state.runs.values()].some((status) => ACTIVE_RUN.has(status));
  const brain = browserBrain();
  // VoiceHost matches the bridge's workspace with its config's; the thread is the whole workspace here.
  const workspaceRoot = brain ? `t3:${brain.threadId}` : null;
  const hello = () => ({
    type: "hello",
    connected: state.connected,
    error: state.error,
    workspaceRoot,
    shell: state.thread && { ...state.thread, active: active() },
    rows: [...state.rows.values()],
  });
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event);
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
      permission ??= await localNetworkPermission();
      if (permission) permission.onchange = now;
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
                runs: { id: string; status: string }[];
                visibleTurnItems: { visibility: string; item: Item }[];
              };
              state.thread = projection.thread;
              state.runs = new Map(projection.runs.map((run) => [run.id, run.status]));
              state.rows = new Map(
                projection.visibleTurnItems
                  .slice(-MAX_ROWS)
                  .map((row) => [row.item.id, slim(row.visibility, row.item)]),
              );
              state.connected = true;
              state.error = null;
              failures = 0;
              emit(hello());
              for (const wake of waiters) wake();
              waiters.clear();
            } else if (chunk.kind === "event" && chunk.event) {
              const { type, payload } = chunk.event as { type: string; payload: Item & { threadId?: string; status?: string } };
              if (type === "turn-item.updated" && payload.threadId === brain.threadId) {
                const row = slim("local", payload);
                state.rows.delete(row.item.id);
                state.rows.set(row.item.id, row);
                while (state.rows.size > MAX_ROWS) state.rows.delete(state.rows.keys().next().value!);
                emit({ type: "row", row });
              } else if (type === "run.created" || type === "run.updated") {
                const was = active();
                state.runs.set(payload.id, payload.status ?? "");
                if (active() !== was) emit({ type: "active", value: active() });
              }
            }
          },
        )
        .done.catch((error: Error) => {
          if (socket !== next) return;
          // The thread's stream ended with the socket still up: start over on a fresh one.
          socket = null;
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

  return {
    config: async () => (workspaceRoot === null ? null : { workspaceRoot, model: null }),
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
        socket?.close();
        socket = null;
      };
    },
    async send(command) {
      const { threadId, message } = command as {
        threadId: string;
        message: { messageId: string; text: string; attachments?: { dataUrl?: string }[] };
      };
      if (brain === null || threadId !== brain.threadId) throw new Error("Not the brain thread");
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
          attachments,
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
