// lalala's stand-in for T3's client state: one socket to T3's public API that follows the
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
  pairWithCode,
  pairWithLink,
  sessionInfo,
  t3Origin,
  uuid,
} from "./t3client.mjs";

const PREFIX = "/__lalala/t3";
const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const MAX_ROWS = 400;
const SEND_WAITS_FOR_T3_MS = 5_000;
// A data event, not an SSE comment, so the page (src/t3/bridge.ts) can tell a live stream from one a
// restart left open behind the phone's front door, which never ends it.
const PING_EVERY_MS = 10_000;
// T3's per-file attachment cap (PROVIDER_SEND_TURN_MAX_FILE_BYTES); the mint refuses anything larger.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// T3's secret cards (`request_secret`): a thread's shell names its waiting card by this turn item id.
const SECRET_ITEM = "turn-item:secret-request:";
// T3's own texts for a card that can't be answered. Anything else gets the generic line, so nothing
// T3 or the socket says back (which could quote the request) reaches the page or a log.
const SECRET_FAILURES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
};
const SECRET_FAILED = "Could not answer the request. Try again.";
const isCompaction = (message) =>
  message.role === "user" &&
  message.text?.trim().toLowerCase() === "/compact" &&
  (message.attachments?.length ?? 0) === 0;
const slimRun = (run) => ({
  status: run.status,
  userMessageId: run.userMessageId,
  completedAt: run.completedAt ?? null,
});
const PROJECT_NAME = "lalala";
const BRAIN_TITLE = "brain";
// The page only reads these fields (VoiceHost, brief.ts); everything else stays on the server.
const slim = (visibility, item) => ({
  visibility,
  item: {
    id: item.id,
    type: item.type,
    text: item.type === "assistant_message" ? (item.text ?? "") : "",
    streaming: item.streaming === true,
    parentItemId: item.parentItemId ?? null,
    // The user's message by its id: replies that start after it answer it (topicHold).
    messageId: item.type === "user_message" ? (item.messageId ?? null) : null,
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
  process.env.LALALA_SETTINGS_FILE?.trim() || NodePath.join(stateDir(), "settings.json");
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

// Without LALALA_THREAD_ID, the brain thread this checkout made (or found) for the paired T3.
const brainFile = () => NodePath.join(stateDir(), "brain.json");
function readStoredBrain() {
  try {
    const stored = JSON.parse(NodeFS.readFileSync(brainFile(), "utf8"));
    return stored.origin === t3Origin() && typeof stored.threadId === "string" ? stored.threadId : null;
  } catch {
    return null;
  }
}
function storeBrain(threadId) {
  NodeFS.mkdirSync(stateDir(), { recursive: true });
  NodeFS.writeFileSync(brainFile(), JSON.stringify({ origin: t3Origin(), threadId }));
}

export function t3BridgePlugin({ threadId: configuredThreadId, workspaceRoot }) {
  const state = {
    threadId: configuredThreadId || null,
    notice: null,
    thread: null,
    rows: new Map(),
    runs: new Map(),
    // The brain's context for the page's compact-on-return (src/voice/brainCompaction.ts).
    usage: null,
    claude: false,
    compactions: new Set(),
    contextLine: "null",
    connected: false,
    error: null,
    server: null,
    // Secret cards waiting in any thread, by turn item id: what the bar's card shows. Never a value.
    asks: new Map(),
    // The waiting card each thread's shell names, by thread id.
    waiting: new Map(),
    // The brain's running delegates, each followed on its own socket, by thread id.
    delegates: new Map(),
  };
  const listeners = new Set();
  // Pairing waits on these for the next hello, so it can answer with the outcome.
  const helloWaiters = new Set();
  let socket = null;
  let timer = null;
  let generation = 0;

  const active = () => [...state.runs.values()].some((run) => ACTIVE_RUN.has(run.status));
  const context = () => {
    if (state.usage === null) return null;
    let compacting = false;
    let compactedAt = null;
    for (const run of state.runs.values()) {
      if (!state.compactions.has(run.userMessageId)) continue;
      if (ACTIVE_RUN.has(run.status)) compacting = true;
      else if (run.status === "completed" && run.completedAt !== null) {
        compactedAt = Math.max(compactedAt ?? 0, Date.parse(run.completedAt));
      }
    }
    return {
      usedTokens: state.usage.usedTokens,
      maxTokens: state.usage.maxTokens ?? null,
      reportedAt: Date.parse(state.usage.updatedAt),
      cacheTtlMs: state.usage.promptCacheTtlMs ?? null,
      claude: state.claude,
      compacting,
      compactedAt,
    };
  };
  const compacting = () => context()?.compacting === true;
  // Newest report of the thread's active provider session.
  const takeUsage = (turn) => {
    if (turn.tokenUsage === undefined) return;
    if (turn.providerThreadId !== state.thread?.activeProviderThreadId) return;
    if (state.usage !== null && Date.parse(turn.tokenUsage.updatedAt) < Date.parse(state.usage.updatedAt)) {
      return;
    }
    state.usage = turn.tokenUsage;
  };
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
    context: context(),
    asks: [...state.asks.values()],
  });
  const broadcastContext = () => {
    const line = JSON.stringify(context());
    if (line === state.contextLine) return;
    state.contextLine = line;
    broadcast({ type: "context", context: JSON.parse(line) });
  };
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
        forgetAsks();
        broadcast(hello());
        schedule(2_000);
      };
      if (!state.threadId) state.threadId = readStoredBrain() ?? (await ensureBrain(next));
      if (gen !== generation) return;
      void readServer(next)
        .then((config) => followSecretAsks(next, config))
        .catch(() => {});
      void next
        .stream(
          "orchestration.subscribeThread",
          { threadId: state.threadId, acceptBoundedSnapshot: true },
          (chunk) => {
            if (chunk.kind === "snapshot") {
              const projection = chunk.projection;
              state.thread = projection.thread;
              state.runs = new Map(projection.runs.map((run) => [run.id, slimRun(run)]));
              state.compactions = new Set(
                projection.messages.filter(isCompaction).map((message) => message.id),
              );
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
              broadcast(hello());
            } else if (chunk.kind === "event") {
              const { type, payload } = chunk.event;
              if (type === "turn-item.updated" && payload.threadId === state.threadId) {
                upsert(slim("local", payload));
              } else if (type === "run.created" || type === "run.updated") {
                const was = active();
                state.runs.set(payload.id, slimRun(payload));
                if (active() !== was) broadcast({ type: "active", value: active() });
                broadcastContext();
              } else if (type === "provider-turn.updated") {
                takeUsage(payload);
                broadcastContext();
              } else if (type === "provider-thread.updated") {
                if (payload.id === state.thread?.activeProviderThreadId) {
                  state.claude = payload.driver === "claudeAgent";
                  broadcastContext();
                }
              } else if (type === "message.updated") {
                if (isCompaction(payload)) {
                  state.compactions.add(payload.id);
                  broadcastContext();
                }
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
          // The stored brain thread is gone (deleted in T3): make or find another on the next connect.
          if (!configuredThreadId && /not found|does not exist|unknown thread/i.test(error.message)) {
            NodeFS.rmSync(brainFile(), { force: true });
            state.threadId = null;
          }
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

  /**
   * The brain thread for this folder: its T3 project (made once, named "lalala") and the newest
   * "brain" thread there, or a new one on the project's or T3's default model.
   */
  async function ensureBrain(via) {
    const { projects, threads } = await via.snapshot("orchestration.subscribeShell", {});
    const config = await readServer(via);
    const mine = projects.filter((p) => p.workspaceRoot === workspaceRoot);
    let project = mine.find((p) => !p.archivedAt) ?? mine[0];
    if (project?.archivedAt) {
      project = await via.request("projects.mutate", {
        type: "project.update",
        commandId: uuid(),
        projectId: project.id,
        archived: false,
      });
    } else if (!project) {
      state.notice = `Created a "${PROJECT_NAME}" project for this folder in T3 Code, for your voice thread.`;
      project = await via.request("projects.mutate", {
        type: "project.create",
        commandId: uuid(),
        projectId: uuid(),
        title: PROJECT_NAME,
        workspaceRoot,
      });
    }
    const existing = threads
      .filter((t) => t.projectId === project.id && t.title === BRAIN_TITLE && !t.archivedAt)
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    let threadId = existing?.id;
    if (!threadId) {
      const provider = slimProviders(config.providers)[0];
      const modelSelection =
        project.defaultModelSelection ??
        config.settings?.defaultModelSelection ??
        (provider && { instanceId: provider.instanceId, model: provider.models[0].slug });
      if (!modelSelection) throw new Error("T3 Code has no model to start the brain thread with");
      ({ threadId } = await via.request("orchestration.launchThread", {
        commandId: uuid(),
        creationSource: "web",
        projectId: project.id,
        title: BRAIN_TITLE,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      }));
    }
    storeBrain(threadId);
    return threadId;
  }

  const broadcastAsks = () => broadcast({ type: "asks", asks: [...state.asks.values()] });

  const askOf = (thread, item) => ({
    threadId: thread.id,
    turnItemId: item.id,
    thread: thread.title ?? "",
    label: item.label,
    reason: item.reason ?? "",
    placeholder: item.placeholder ?? null,
    file: item.delivery === "file",
  });
  function forgetAsks() {
    state.asks.clear();
    state.waiting.clear();
    const delegates = [...state.delegates.values()];
    state.delegates.clear();
    for (const child of delegates) child.close();
  }

  // One thread's shell: its waiting secret card, if any, with the card's label read from its item.
  async function takeShell(via, thread) {
    followDelegate(via, thread);
    const pending = thread.pendingRuntimeRequest?.id;
    const itemId = typeof pending === "string" && pending.startsWith(SECRET_ITEM) ? pending : null;
    const was = state.waiting.get(thread.id) ?? null;
    if (was === itemId) return;
    if (itemId === null) state.waiting.delete(thread.id);
    else state.waiting.set(thread.id, itemId);
    if (was !== null && state.asks.delete(was)) broadcastAsks();
    if (itemId === null) return;
    try {
      const { item } = await via.request("orchestration.getTurnItem", {
        threadId: thread.id,
        itemId,
      });
      if (via !== socket || state.waiting.get(thread.id) !== itemId) return;
      if (item?.type !== "secret_request" || item.secretStatus !== "pending") return;
      state.asks.set(itemId, askOf(thread, item));
      broadcastAsks();
    } catch {
      // The next change to this thread's shell reads it again.
      if (state.waiting.get(thread.id) === itemId) state.waiting.delete(thread.id);
    }
  }

  // T3 leaves a subagent's turn items out of the shell stream, so a delegate's secret card never shows
  // on its shell while it waits. Each running delegate of the brain is followed on a socket of its own
  // (closing it ends the subscription) for as long as it runs.
  function followDelegate(via, thread) {
    const running =
      via === socket &&
      thread.lineage?.relationshipToParent === "subagent" &&
      thread.lineage.rootThreadId === state.threadId &&
      thread.activeRunId != null;
    const followed = state.delegates.get(thread.id);
    if (!running) {
      if (followed === undefined) return;
      state.delegates.delete(thread.id);
      followed.close();
      let dropped = false;
      for (const [id, ask] of state.asks) {
        if (ask.threadId === thread.id && state.asks.delete(id)) dropped = true;
      }
      if (dropped) broadcastAsks();
      return;
    }
    if (followed !== undefined) return;
    const child = new T3Socket();
    state.delegates.set(thread.id, child);
    const current = () => state.delegates.get(thread.id) === child;
    const take = (item, runId) => {
      if (item?.type !== "secret_request" || item.threadId !== thread.id) return;
      // An old card of a run that died without closing it stays pending forever: only this run's.
      const waits = item.secretStatus === "pending" && (runId === undefined || item.runId === runId);
      if (waits ? state.asks.has(item.id) : !state.asks.delete(item.id)) return;
      if (waits) state.asks.set(item.id, askOf(thread, item));
      broadcastAsks();
    };
    child.onClose = () => {
      if (current()) state.delegates.delete(thread.id);
    };
    child
      .connect()
      .then(() => {
        if (!current()) return child.close();
        return child.stream(
          "orchestration.subscribeThread",
          { threadId: thread.id, acceptBoundedSnapshot: true },
          (chunk) => {
            if (!current()) return;
            if (chunk.kind === "snapshot") {
              for (const item of chunk.projection.turnItems) take(item, thread.activeRunId);
            } else if (chunk.kind === "event" && chunk.event.type === "turn-item.updated") {
              take(chunk.event.payload);
            }
          },
        );
      })
      .catch(() => child.close());
  }

  // Every thread's shell, so a secret asked in any thread (not only the brain's) shows. Later
  // snapshots only refresh projects and carry no threads, so a thread missing from one means nothing.
  function followSecretAsks(via, config) {
    const families = config?.shellThreadFamilies === true;
    return via.stream(
      "orchestration.subscribeShell",
      {
        ...(families ? { omitIdleSubagents: true } : {}),
        ...(families && config.shellOlderSettled === true ? { omitOlderSettled: true } : {}),
      },
      (chunk) => {
        if (chunk.kind === "snapshot") {
          for (const thread of chunk.snapshot.threads) void takeShell(via, thread);
        } else if (chunk.kind === "thread.updated") {
          void takeShell(via, chunk.location === "active" ? chunk.thread : { id: chunk.thread.id });
        } else if (chunk.kind === "thread.removed") {
          void takeShell(via, { id: chunk.threadId });
        }
      },
    );
  }

  /** Hands the user's answer to T3's own `secrets.answerRequest`. Returns what to tell him, or null. */
  async function answerSecret(input) {
    const ask = state.asks.get(String(input?.turnItemId ?? ""));
    if (ask === undefined) return SECRET_FAILURES.not_found;
    const decline = input.answer?.type === "decline";
    const secret = decline ? "" : String(input.answer?.secret ?? "").trim();
    if ((!decline && secret === "") || socket === null) return SECRET_FAILED;
    try {
      await socket.request("secrets.answerRequest", {
        threadId: ask.threadId,
        turnItemId: ask.turnItemId,
        answer: decline ? { type: "decline" } : { type: "save", secret },
      });
    } catch (error) {
      const reason = /"reason":"([a-z_]+)"/.exec(String(error?.message))?.[1];
      return SECRET_FAILURES[reason] ?? SECRET_FAILED;
    }
    if (state.asks.delete(ask.turnItemId)) broadcastAsks();
    return null;
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
    forgetAsks();
    broadcastAsks();
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
      brainThread: state.threadId ? { id: state.threadId, title: state.thread?.title ?? null } : null,
      notice: state.notice,
    };
  };

  async function pairAndConnect(body) {
    if (typeof body?.link === "string") await pairWithLink(body.link);
    else if (typeof body?.code === "string") await pairWithCode(body.code);
    else if (body?.local === true) await pair();
    else throw new Error("Give a pairing link or code");
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

  // A send right after a restart (this server's or T3's) waits a moment for the socket.
  async function connectedSocket() {
    for (let waited = 0; socket === null && waited < SEND_WAITS_FOR_T3_MS; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    if (!state.threadId) throw new Error("No brain thread yet: pair with T3 Code in the settings");
    return socket;
  }

  async function send({ commandId, threadId, message, runtimeMode, interactionMode }) {
    const via = await connectedSocket();
    if (threadId !== state.threadId) throw new Error("Not the brain thread");
    // Two devices back at once both ask; one compaction is enough.
    if (message.idleCompaction !== undefined && compacting()) return null;
    const uploads = (message.attachments ?? []).filter((a) => typeof a.dataUrl === "string");
    const attachments =
      uploads.length === 0
        ? []
        : (
            await via.request("assets.persistChatAttachments", {
              threadId,
              messageId: message.messageId,
              attachments: uploads,
            })
          ).attachments;
    void runtimeMode;
    void interactionMode;
    return via.request("orchestration.dispatchCommand", {
      type: "message.dispatch",
      // The page's outbox keeps one id per message, so T3 takes a resend after a lost answer once.
      commandId: typeof commandId === "string" && commandId !== "" ? commandId : uuid(),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: message.messageId,
      text: message.text,
      attachments,
      ...(message.idleCompaction === undefined ? {} : { idleCompaction: message.idleCompaction }),
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
  // The paperclip's file (src/state/voiceUpload.ts): held here, then T3 mints a pending upload and
  // takes the bytes on its signed URL. The send claims it by id, like the web composer's upload.
  const tooLarge = () =>
    Object.assign(new Error(`file too large (${MAX_UPLOAD_BYTES / 1024 / 1024} MB max)`), {
      status: 413,
    });
  const readUpload = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      // Past the cap the rest drains unread, so the phone still gets the 413's reason.
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_UPLOAD_BYTES) chunks.push(chunk);
      });
      req.on("end", () =>
        size > MAX_UPLOAD_BYTES ? reject(tooLarge()) : resolve(Buffer.concat(chunks)),
      );
      req.on("error", reject);
    });

  async function upload(req) {
    if (!socket) throw new Error(state.error ?? "Not connected to T3 Code");
    if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
      throw tooLarge();
    }
    let name = "file";
    try {
      const header = decodeURIComponent(String(req.headers["x-lalala-name"] ?? ""));
      name = header.trim().slice(0, 255) || "file";
    } catch {}
    const mimeType =
      String(req.headers["content-type"] ?? "").split(";")[0].trim().slice(0, 100) ||
      "application/octet-stream";
    const bytes = await readUpload(req);
    if (bytes.length === 0) throw Object.assign(new Error("empty file"), { status: 400 });
    const minted = await socket.request("attachments.createUploadUrl", {
      type: "file",
      name,
      mimeType,
      sizeBytes: bytes.length,
    });
    const response = await fetch(new URL(minted.relativeUrl, t3Origin()), {
      method: "POST",
      headers: { "content-type": mimeType, "content-length": String(bytes.length) },
      body: bytes,
    }).catch((cause) => {
      throw new Error(`T3 upload unreachable (${cause.message})`);
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      const { attachmentId } = minted;
      void socket?.request("attachments.delete", { attachmentId }).catch(() => {});
      const reason = `T3 refused the upload (${response.status}${detail ? `: ${detail}` : ""})`;
      throw Object.assign(new Error(reason), { status: 502 });
    }
    return { attachmentId: minted.attachmentId };
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return {
    name: "lalala:t3-bridge",
    configureServer(server) {
      void connect();
      // Vite restarts in-process when this file changes; this instance's T3 sockets would live on.
      server.httpServer?.once("close", () => {
        clearTimeout(timer);
        generation++;
        const old = socket;
        socket = null;
        forgetAsks();
        old?.close();
      });
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
          const keepAlive = setInterval(() => res.write('data: {"type":"ping"}\n\n'), PING_EVERY_MS);
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
        if (path === `${PREFIX}/upload` && req.method === "POST") {
          upload(req)
            .then((result) => json(res, 200, result))
            .catch((error) => {
              if (!res.headersSent) json(res, error.status ?? 502, { error: error.message });
            });
          return;
        }
        if (path === `${PREFIX}/secret` && req.method === "POST") {
          // The body holds a secret: it is never logged, kept or echoed, and errors are fixed texts.
          readBody(req)
            .then((raw) => answerSecret(JSON.parse(raw)))
            .then((problem) =>
              problem === null
                ? json(res, 200, { ok: true })
                : json(res, 409, { error: problem }),
            )
            .catch(() => json(res, 502, { error: SECRET_FAILED }));
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

