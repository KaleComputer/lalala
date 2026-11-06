// lalala.talk's harness: the tab itself follows the brain thread on the visitor's own T3 Code
// (paired on /connect) and sends turns to it, speaking the same events as vite/t3bridge.mjs.
import type { HarnessAdapter } from "..";
import { T3Socket, readBrainThread, readSession, uuid } from "./t3";

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const MAX_ROWS = 400;

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

/** The paired T3 and its brain thread, or null until /connect has both. */
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
  let retry: ReturnType<typeof setTimeout> | undefined;

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

  async function connect() {
    if (brain === null) {
      state.error = "Not paired with T3 Code yet";
      return emit(hello());
    }
    try {
      const next = new T3Socket(brain.session);
      await next.connect();
      socket = next;
      next.onClose = () => {
        socket = null;
        state.connected = false;
        emit(hello());
        retry = setTimeout(connect, 2_000);
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
              emit(hello());
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
          state.error = `T3: ${error.message}`;
          emit(hello());
          next.close();
        });
    } catch (error) {
      state.connected = false;
      state.error = `T3: ${(error as Error).message}`;
      emit(hello());
      retry = setTimeout(connect, 5_000);
    }
  }

  return {
    config: async () => (workspaceRoot === null ? null : { workspaceRoot, model: null }),
    events(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        void connect();
      } else listener(hello());
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        clearTimeout(retry);
        socket?.close();
        socket = null;
        started = false;
      };
    },
    async send(command) {
      const { threadId, message } = command as {
        threadId: string;
        message: { messageId: string; text: string; attachments?: { dataUrl?: string }[] };
      };
      if (socket === null) throw new Error(state.error ?? "Not connected to T3 Code");
      if (brain === null || threadId !== brain.threadId) throw new Error("Not the brain thread");
      const uploads = (message.attachments ?? []).filter((a) => typeof a.dataUrl === "string");
      const attachments =
        uploads.length === 0
          ? []
          : (
              await socket.request<{ attachments: unknown[] }>("assets.persistChatAttachments", {
                threadId,
                messageId: message.messageId,
                attachments: uploads,
              })
            ).attachments;
      return socket.dispatch({
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
    },
  };
}
