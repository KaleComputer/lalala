// A browser client for the visitor's own T3 Code server: pairing-link exchange, a WebSocket
// ticket, and the Effect RPC JSON protocol T3's own clients speak on /ws. T3 already answers
// cross-origin bearer requests (CORS `*`), so no helper or server change is needed.

const PROTOCOL = 2;
const SESSION_KEY = "lalala.t3.session";

export type Session = { origin: string; accessToken: string; expiresAt: number };

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/i;

/**
 * Chrome's Local Network Access: an https page reaching http://loopback must say so up front,
 * or mixed-content blocking stops it before the permission prompt ever shows.
 */
function localFetch(url: string, init: RequestInit = {}) {
  const target = new URL(url);
  const extra = LOOPBACK.test(target.hostname) ? { targetAddressSpace: "loopback" } : {};
  return fetch(url, { ...init, ...extra } as RequestInit);
}

export function readSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return session && session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export const forgetSession = () => localStorage.removeItem(SESSION_KEY);

/** Trades a T3 pairing link (`http://127.0.0.1:3773/pair#token=…`) for a bearer session. */
export async function pairWithLink(link: string): Promise<Session> {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("That is not a link.");
  }
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new Error("That link has no pairing token.");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "lalala.talk",
    client_device_type: "desktop",
  });
  let response: Response;
  try {
    response = await localFetch(`${url.origin}/oauth/token`, { method: "POST", body });
  } catch {
    throw new Error(
      `Could not reach ${url.origin}. Is T3 Code running, and did the browser allow local network access?`,
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(
      result.error === "invalid_grant"
        ? "That pairing link was already used or expired. Make a new one."
        : `T3 answered ${response.status} ${result.error ?? ""}.`,
    );
  }
  const session = {
    origin: url.origin,
    accessToken: result.access_token as string,
    expiresAt: Date.now() + Number(result.expires_in) * 1000,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onChunk?: (value: never) => void;
};

/** One RPC socket. `request` resolves with the Exit's value; `stream` calls back per chunk. */
export class T3Socket {
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<string, Pending>();
  #ping: ReturnType<typeof setInterval> | undefined;
  onClose = () => {};

  constructor(readonly session: Session) {}

  async connect() {
    let ticketResponse: Response;
    try {
      ticketResponse = await localFetch(`${this.session.origin}/api/auth/websocket-ticket/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.session.accessToken}` },
      });
    } catch {
      throw new Error(`Could not reach ${this.session.origin}. Is T3 Code running?`);
    }
    if (ticketResponse.status === 401) throw new Error("T3 no longer accepts this pairing.");
    if (!ticketResponse.ok) throw new Error(`T3 answered ${ticketResponse.status}.`);
    const { ticket } = await ticketResponse.json();
    const url = new URL("/ws", this.session.origin.replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", String(PROTOCOL));
    url.searchParams.set("wsTicket", ticket);
    const ws = new WebSocket(url);
    this.#ws = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("The T3 socket failed to open.")), {
        once: true,
      });
    });
    ws.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    ws.addEventListener("close", () => {
      clearInterval(this.#ping);
      for (const pending of this.#pending.values()) pending.reject(new Error("T3 socket closed"));
      this.#pending.clear();
      this.onClose();
    });
    this.#ping = setInterval(() => this.#send({ _tag: "Ping" }), 10_000);
  }

  close() {
    this.onClose = () => {};
    this.#ws?.close();
  }

  #send(message: unknown) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #onMessage(raw: string) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const pending = this.#pending.get(String(message.requestId));
    if (message._tag === "Chunk" && pending) {
      for (const value of message.values) pending.onChunk?.(value as never);
      this.#send({ _tag: "Ack", requestId: message.requestId });
    } else if (message._tag === "Exit" && pending) {
      this.#pending.delete(String(message.requestId));
      if (message.exit._tag === "Success") pending.resolve(message.exit.value);
      else pending.reject(new Error(describeCause(message.exit.cause)));
    }
  }

  #call<T>(tag: string, payload: unknown, onChunk?: (value: T) => void) {
    const id = String(this.#nextId++);
    const done = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onChunk: onChunk as Pending["onChunk"] });
      this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    });
    return { id, done };
  }

  request<T>(tag: string, payload: unknown) {
    return this.#call(tag, payload).done as Promise<T>;
  }

  /** Streams chunks until `stop()`. */
  stream<T>(tag: string, payload: unknown, onChunk: (value: T) => void) {
    const { id, done } = this.#call(tag, payload, onChunk);
    done.catch(() => {});
    return {
      done,
      stop: () => {
        this.#pending.delete(id);
        this.#send({ _tag: "Interrupt", requestId: id, interruptors: [] });
      },
    };
  }

  dispatch(command: Record<string, unknown>) {
    return this.request("orchestration.dispatchCommand", { commandId: uuid(), ...command });
  }
}

function describeCause(cause: unknown) {
  const first = Array.isArray(cause) ? cause[0] : undefined;
  if (first?._tag === "Fail") return first.error?.message ?? JSON.stringify(first.error);
  if (first?._tag === "Die") return String(first.defect?.message ?? first.defect);
  return "interrupted";
}

export const uuid = () => crypto.randomUUID();

export type ModelSelection = { instanceId: string; model: string };
export type Project = {
  id: string;
  title: string;
  defaultModelSelection: ModelSelection | null;
  archivedAt?: string | null;
};
export type ThreadShell = { id: string; projectId: string; title: string; updatedAt?: string };
export type Provider = { instanceId: string; name: string; models: { slug: string; name: string }[] };

/** Projects, threads and models once, for the picker. */
export async function readWorkspace(socket: T3Socket) {
  const snapshot = await new Promise<{ projects: Project[]; threads: ThreadShell[] }>(
    (resolve, reject) => {
      const sub = socket.stream<{ kind: string; snapshot?: never }>(
        "orchestration.subscribeShell",
        {},
        (chunk) => {
          if (chunk.kind !== "snapshot") return;
          sub.stop();
          resolve(chunk.snapshot as never);
        },
      );
      sub.done.catch(reject);
    },
  );
  const config = await socket.request<{
    environment?: { label?: string };
    settings?: { defaultModelSelection?: ModelSelection };
    providers: {
      instanceId: string;
      displayName?: string;
      driver: string;
      enabled: boolean;
      installed: boolean;
      models: { slug: string; name: string }[];
    }[];
  }>("server.getConfig", {});
  const providers: Provider[] = config.providers
    .filter((p) => p.enabled && p.installed && p.models.length > 0)
    .map((p) => ({
      instanceId: p.instanceId,
      name: p.displayName ?? p.driver,
      models: p.models.map((m) => ({ slug: m.slug, name: m.name })),
    }));
  return {
    label: config.environment?.label ?? "T3 Code",
    projects: snapshot.projects.filter((p) => !p.archivedAt),
    threads: [...snapshot.threads].sort((a, b) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
    ),
    providers,
    defaultModel: config.settings?.defaultModelSelection ?? null,
  };
}

export async function launchVoiceThread(
  socket: T3Socket,
  projectId: string,
  modelSelection: ModelSelection,
) {
  const result = await socket.request<{ threadId: string }>("orchestration.launchThread", {
    commandId: uuid(),
    creationSource: "web",
    projectId,
    title: "Voice (lalala.talk)",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  return result.threadId;
}

export const sendMessage = (socket: T3Socket, threadId: string, text: string) =>
  socket.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId: uuid(),
    text,
    attachments: [],
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  });

export type ReplyItem = { id: string; text: string; streaming: boolean };

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Follows a thread: `onReply` for every top-level assistant message created after subscribing
 * (full text so far, each update), `onBusy` when a run starts or settles.
 */
export function followThread(
  socket: T3Socket,
  threadId: string,
  handlers: {
    onTitle: (title: string) => void;
    onReply: (item: ReplyItem) => void;
    onBusy: (busy: boolean) => void;
    onProblem: (text: string) => void;
  },
) {
  const known = new Set<string>();
  const runs = new Map<string, string>();
  const busy = () => [...runs.values()].some((status) => ACTIVE_RUN.has(status));
  return socket.stream<{
    kind: string;
    projection?: {
      thread: { title: string };
      runs: { id: string; status: string }[];
      visibleTurnItems: { item: { id: string } }[];
    };
    event?: { type: string; payload: Record<string, never> };
  }>("orchestration.subscribeThread", { threadId, acceptBoundedSnapshot: true }, (chunk) => {
    if (chunk.kind === "snapshot" && chunk.projection) {
      handlers.onTitle(chunk.projection.thread.title);
      for (const row of chunk.projection.visibleTurnItems) known.add(row.item.id);
      for (const run of chunk.projection.runs) runs.set(run.id, run.status);
      handlers.onBusy(busy());
    } else if (chunk.kind === "event" && chunk.event) {
      const { type, payload } = chunk.event;
      if (type === "turn-item.updated" && payload.threadId === threadId) {
        const item = payload as unknown as {
          id: string;
          type: string;
          text?: string;
          streaming?: boolean;
          parentItemId?: string | null;
        };
        if (item.parentItemId || known.has(item.id)) return;
        if (item.type === "error") return handlers.onProblem(item.text ?? "The agent hit an error.");
        if (item.type !== "assistant_message") return;
        handlers.onReply({ id: item.id, text: item.text ?? "", streaming: item.streaming === true });
      } else if (type === "run.created" || type === "run.updated") {
        const run = payload as unknown as { id: string; status: string };
        runs.set(run.id, run.status);
        handlers.onBusy(busy());
      }
    }
  });
}
