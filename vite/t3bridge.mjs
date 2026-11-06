// t3voice's stand-in for T3's client state: one socket to T3's public API that follows the
// brain thread (bounded snapshot, then its events) and sends the user's turns the way the web composer
// does (`message.dispatch`, attachments persisted first). The page gets it over SSE.
import { T3Socket, uuid } from "./t3client.mjs";

const PREFIX = "/__t3voice/t3";
const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const MAX_ROWS = 400;
// The page only reads these fields (VoiceHost, brief.ts); everything else stays on the server.
const slim = (visibility, item) => ({
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

export function t3BridgePlugin({ threadId: configuredThreadId, workspaceRoot }) {
  const state = {
    threadId: configuredThreadId,
    thread: null,
    rows: new Map(),
    runs: new Map(),
    connected: false,
    error: null,
  };
  const listeners = new Set();
  let socket = null;

  const active = () => [...state.runs.values()].some((status) => ACTIVE_RUN.has(status));
  const shell = () =>
    state.thread && {
      id: state.thread.id,
      projectId: state.thread.projectId,
      title: state.thread.title,
      createdAt: state.thread.createdAt,
      runtimeMode: state.thread.runtimeMode,
      interactionMode: state.thread.interactionMode,
      active: active(),
    };
  const hello = () => ({
    type: "hello",
    connected: state.connected,
    error: state.error,
    workspaceRoot,
    shell: shell(),
    rows: [...state.rows.values()],
  });
  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) res.write(line);
  };

  function upsert(row) {
    state.rows.delete(row.item.id);
    state.rows.set(row.item.id, row);
    while (state.rows.size > MAX_ROWS) state.rows.delete(state.rows.keys().next().value);
    broadcast({ type: "row", row });
  }

  async function connect() {
    try {
      const next = new T3Socket();
      await next.connect();
      socket = next;
      next.onClose = () => {
        socket = null;
        state.connected = false;
        broadcast(hello());
        setTimeout(connect, 2_000);
      };
      void next
        .stream(
          "orchestration.subscribeThread",
          { threadId: state.threadId, acceptBoundedSnapshot: true },
          (chunk) => {
            if (chunk.kind === "snapshot") {
              const projection = chunk.projection;
              state.thread = projection.thread;
              state.runs = new Map(projection.runs.map((run) => [run.id, run.status]));
              state.rows = new Map(
                projection.visibleTurnItems
                  .slice(-MAX_ROWS)
                  .map((row) => [row.item.id, slim(row.visibility, row.item)]),
              );
              state.connected = true;
              state.error = null;
              broadcast(hello());
            } else if (chunk.kind === "event") {
              const { type, payload } = chunk.event;
              if (type === "turn-item.updated" && payload.threadId === state.threadId) {
                upsert(slim("local", payload));
              } else if (type === "run.created" || type === "run.updated") {
                const was = active();
                state.runs.set(payload.id, payload.status);
                if (active() !== was) broadcast({ type: "active", value: active() });
              } else if (type === "thread.updated" || type === "thread.runtime-mode-updated") {
                if (payload && typeof payload === "object" && payload.id === state.threadId) {
                  state.thread = { ...state.thread, ...payload };
                }
              }
            }
          },
        )
        .catch((error) => {
          state.error = `T3: ${error.message}`;
          broadcast(hello());
          next.close();
        });
    } catch (error) {
      state.connected = false;
      state.error = `T3: ${error.message}`;
      broadcast(hello());
      setTimeout(connect, 5_000);
    }
  }

  async function send({ threadId, message, runtimeMode, interactionMode }) {
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    if (threadId !== state.threadId) throw new Error("Not the brain thread");
    const uploads = (message.attachments ?? []).filter((a) => typeof a.dataUrl === "string");
    const attachments =
      uploads.length === 0
        ? []
        : (
            await socket.request("assets.persistChatAttachments", {
              threadId,
              messageId: message.messageId,
              attachments: uploads,
            })
          ).attachments;
    void runtimeMode;
    void interactionMode;
    return socket.request("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: uuid(),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: message.messageId,
      text: message.text,
      attachments,
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        // Pictures travel as data URLs (VoiceInput caps each at 10 MB).
        if (size > 64 * 1024 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return {
    name: "t3voice:t3-bridge",
    configureServer(server) {
      void connect();
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!path.startsWith(`${PREFIX}/`)) return next();
        if (path === `${PREFIX}/events`) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write(`data: ${JSON.stringify(hello())}\n\n`);
          listeners.add(res);
          const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
          req.on("close", () => {
            clearInterval(keepAlive);
            listeners.delete(res);
          });
          return;
        }
        if (path === `${PREFIX}/send` && req.method === "POST") {
          readBody(req)
            .then((raw) => send(JSON.parse(raw)))
            .then(() => json(res, 200, { ok: true }))
            .catch((error) => json(res, 502, { error: error.message }));
          return;
        }
        json(res, 404, { error: "unknown route" });
      });
    },
  };
}

