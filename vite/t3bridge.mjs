// t3voice's stand-in for T3's client state: one socket to T3's public API that follows the
// brain thread (bounded snapshot, then its events) and sends the user's turns the way the web composer
// does (`message.dispatch`, attachments persisted first). The page gets it over SSE.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { stateDir } from "./stateDir.mjs";
import {
  T3Socket,
  canPairLocal,
  forgetSession,
  pair,
  pairWithLink,
  sessionInfo,
  uuid,
} from "./t3client.mjs";

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

// The settings page's model lists: enabled, installed providers and each model's own options.
const slimProviders = (providers) =>
  providers
    .filter((provider) => provider.enabled && provider.installed && provider.models.length > 0)
    .map((provider) => ({
      instanceId: provider.instanceId,
      name: provider.displayName ?? provider.driver,
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        options: model.capabilities?.optionDescriptors ?? [],
      })),
    }));

// The voice settings every device shares (the page's voiceSettings.ts); the newest write wins.
const settingsFile = () =>
  process.env.T3VOICE_SETTINGS_FILE?.trim() || NodePath.join(stateDir(), "settings.json");
const readSettings = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(settingsFile(), "utf8"));
  } catch {
    return { at: 0 };
  }
};
function saveSettings(next) {
  const current = readSettings();
  if (typeof next !== "object" || next === null || !(Number(next.at) > Number(current.at || 0))) {
    return current;
  }
  const file = settingsFile();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  NodeFS.renameSync(`${file}.tmp`, file);
  return next;
}

export function t3BridgePlugin({ threadId: configuredThreadId, workspaceRoot }) {
  const state = {
    threadId: configuredThreadId,
    thread: null,
    rows: new Map(),
    runs: new Map(),
    connected: false,
    error: null,
    server: null,
  };
  const listeners = new Set();
  // Pairing waits on these for the next hello, so it can answer with the outcome.
  const helloWaiters = new Set();
  let socket = null;
  let timer = null;
  let generation = 0;

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
    if (event.type === "hello") {
      for (const resolve of helloWaiters) resolve();
      helloWaiters.clear();
    }
  };
  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
  };

  function upsert(row) {
    state.rows.delete(row.item.id);
    state.rows.set(row.item.id, row);
    while (state.rows.size > MAX_ROWS) state.rows.delete(state.rows.keys().next().value);
    broadcast({ type: "row", row });
  }

  async function connect() {
    timer = null;
    const gen = ++generation;
    try {
      const next = new T3Socket();
      await next.connect();
      if (gen !== generation) return next.close();
      socket = next;
      next.onClose = () => {
        if (socket !== next) return;
        socket = null;
        state.connected = false;
        broadcast(hello());
        schedule(2_000);
      };
      void readServer(next);
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
              } else if (
                type === "thread.updated" ||
                type === "thread.runtime-mode-updated" ||
                type === "thread.model-selection-updated" ||
                type === "thread.provider-switched"
              ) {
                if (payload && typeof payload === "object" && payload.id === state.threadId) {
                  state.thread = { ...state.thread, ...payload };
                }
              }
            }
          },
        )
        .catch((error) => {
          if (gen !== generation) return;
          state.error = `T3: ${error.message}`;
          broadcast(hello());
          next.close();
        });
    } catch (error) {
      if (gen !== generation) return;
      state.connected = false;
      state.error = `T3: ${error.message}`;
      broadcast(hello());
      schedule(5_000);
    }
  }

  async function readServer(via) {
    const config = await via.request("server.getConfig", {});
    state.server = {
      label: config.environment?.label ?? "T3 Code",
      version: config.environment?.serverVersion ?? "?",
    };
    return config;
  }

  // Drops the current socket and connects again now, with whatever session is stored.
  function reconnect() {
    const old = socket;
    socket = null;
    state.connected = false;
    state.server = null;
    state.thread = null;
    old?.close();
    schedule(0);
  }

  const connection = () => {
    const session = sessionInfo();
    return {
      harness: "T3 Code",
      paired: session !== null,
      connected: state.connected,
      error: state.error,
      origin: session?.origin ?? null,
      canPairLocal: canPairLocal(),
      server: state.server,
      session: session && { expiresAt: session.expiresAt, renews: session.renews },
      brainThread: { id: state.threadId, title: state.thread?.title ?? null },
    };
  };

  async function pairAndConnect(body) {
    if (typeof body?.link === "string") await pairWithLink(body.link);
    else if (body?.local === true) await pair();
    else throw new Error("Give a pairing link");
    const settled = new Promise((resolve) => {
      helloWaiters.add(resolve);
      setTimeout(resolve, 8_000);
    });
    reconnect();
    await settled;
    return connection();
  }

  function disconnect() {
    forgetSession();
    clearTimeout(timer);
    generation++;
    const old = socket;
    socket = null;
    old?.close();
    state.connected = false;
    state.server = null;
    state.error = "T3: Not paired yet";
    broadcast(hello());
    return connection();
  }

  async function testConnection() {
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    const startedAt = performance.now();
    await readServer(socket);
    return { ok: true, ms: Math.round(performance.now() - startedAt), server: state.server };
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

  async function readBrain() {
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    const config = await readServer(socket);
    return {
      modelSelection: state.thread?.modelSelection ?? null,
      defaultModelSelection: config.settings?.defaultModelSelection ?? null,
      providers: slimProviders(config.providers),
    };
  }

  // The brain thread's model and options, the way t3_thread_configure sets them.
  async function configureBrain({ modelSelection }) {
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    if (typeof modelSelection?.instanceId !== "string" || typeof modelSelection.model !== "string") {
      throw new Error("modelSelection needs instanceId and model");
    }
    const current = state.thread?.providerInstanceId ?? state.thread?.modelSelection?.instanceId;
    await socket.request("orchestration.dispatchCommand", {
      type: current === modelSelection.instanceId ? "thread.model-selection.set" : "provider.switch",
      commandId: uuid(),
      threadId: state.threadId,
      modelSelection,
    });
    state.thread = { ...state.thread, modelSelection, providerInstanceId: modelSelection.instanceId };
    return readBrain();
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
        if (path === `${PREFIX}/brain` && req.method === "GET") {
          readBrain()
            .then((brain) => json(res, 200, brain))
            .catch((error) => json(res, 502, { error: error.message }));
          return;
        }
        if (path === `${PREFIX}/brain` && req.method === "POST") {
          readBody(req)
            .then((raw) => configureBrain(JSON.parse(raw)))
            .then((brain) => json(res, 200, brain))
            .catch((error) => json(res, 502, { error: error.message }));
          return;
        }
        if (path === `${PREFIX}/connection` && req.method === "GET") {
          json(res, 200, connection());
          return;
        }
        if (path === `${PREFIX}/connection/test` && req.method === "POST") {
          testConnection()
            .then((result) => json(res, 200, result))
            .catch((error) => json(res, 502, { error: error.message }));
          return;
        }
        if (path === `${PREFIX}/connection/pair` && req.method === "POST") {
          readBody(req)
            .then((raw) => pairAndConnect(JSON.parse(raw || "{}")))
            .then((result) => json(res, 200, result))
            .catch((error) => json(res, 400, { error: error.message }));
          return;
        }
        if (path === `${PREFIX}/connection/disconnect` && req.method === "POST") {
          json(res, 200, disconnect());
          return;
        }
        if (path === `${PREFIX}/settings` && req.method === "GET") {
          json(res, 200, readSettings());
          return;
        }
        if (path === `${PREFIX}/settings` && req.method === "PUT") {
          readBody(req)
            .then((raw) => json(res, 200, saveSettings(JSON.parse(raw))))
            .catch((error) => json(res, 400, { error: error.message }));
          return;
        }
        json(res, 404, { error: "unknown route" });
      });
    },
  };
}

