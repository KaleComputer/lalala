// lalala.talk's T3 client, straight from the tab to the visitor's own T3 Code server: pairing-link exchange, a WebSocket
// ticket, and the Effect RPC JSON protocol T3's own clients speak on /ws. T3 already answers
// cross-origin bearer requests (CORS `*`), so no helper or server change is needed.

const PROTOCOL = 2;
const SESSION_KEY = "lalala.t3.session";

export type Session = { origin: string; accessToken: string; expiresAt: number };

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/i;
const PRIVATE = /^(10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d+){2}|[^.]+\.local)$/i;

/**
 * Chrome's Local Network Access: an https page reaching http://loopback must say so up front,
 * or mixed-content blocking stops it before the permission prompt ever shows.
 */
function localFetch(url: string, init: RequestInit = {}) {
  const target = new URL(url);
  const extra = LOOPBACK.test(target.hostname)
    ? { targetAddressSpace: "loopback" }
    : PRIVATE.test(target.hostname)
      ? { targetAddressSpace: "local" }
      : {};
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

export const forgetSession = () => {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(THREAD_KEY);
};

const THREAD_KEY = "lalala.t3.thread";

/** The thread this browser talks to (the app's brain thread), for the paired T3 at `origin`. */
export function readBrainThread(origin: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(THREAD_KEY) ?? "null") as { origin?: string; threadId?: string } | null;
    return stored?.origin === origin && typeof stored.threadId === "string" ? stored.threadId : null;
  } catch {
    return null;
  }
}

export const saveBrainThread = (origin: string, threadId: string) =>
  localStorage.setItem(THREAD_KEY, JSON.stringify({ origin, threadId }));

const DEFAULT_ORIGIN = "http://127.0.0.1:3773";

/**
 * Reads what T3 hands out: the bare code (Copy code), a pairing link (`http://127.0.0.1:3773/pair#token=…`),
 * its hosted form (`…/pair?host=…#token=…`), a `t3code://pair?pairingUrl=…` link, or the desktop's own
 * `t3code://app/pair#token=…`, which names no server: codes and those go to T3's default address.
 */
export function readPairing(input: string): { origin: string; token: string } {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(value)) return { origin: DEFAULT_ORIGIN, token: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is neither a pairing code nor a link. Copy it again from T3 Code.");
  }
  const appLink = url.searchParams.get("pairingUrl");
  if (appLink) return readPairing(appLink);
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new Error("That link has no pairing code in it. Copy it again from T3 Code.");
  const host = serverOrigin(url.searchParams.get("host"));
  const own = url.protocol === "http:" || url.protocol === "https:" ? reachable(url) : null;
  return { origin: host ?? own ?? DEFAULT_ORIGIN, token };
}

/** A server bound to every interface (T3 then links `0.0.0.0`) answers on loopback. */
function reachable(url: URL): string {
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  return url.origin;
}

/** The http(s) origin in `value` (a scheme-less `host:port` counts as http), or null when it names none. */
function serverOrigin(value: string | null): string | null {
  if (!value) return null;
  for (const candidate of [value, `http://${value}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return reachable(url);
    } catch {}
  }
  return null;
}

/** Trades a T3 pairing code or link for a bearer session. */
export async function pairWithLink(input: string): Promise<Session> {
  const { origin, token } = readPairing(input);
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
    response = await localFetch(`${origin}/oauth/token`, { method: "POST", body });
  } catch {
    throw new Error(
      `Could not reach ${origin}. Is T3 Code running, and did the browser allow local network access?`,
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(
      result.error === "invalid_grant"
        ? "That pairing code was already used or expired. Make a new one."
        : `T3 answered ${response.status} ${result.error ?? ""}.`,
    );
  }
  const session = {
    origin,
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
    title: "voice (lalala.talk)",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  return result.threadId;
}

