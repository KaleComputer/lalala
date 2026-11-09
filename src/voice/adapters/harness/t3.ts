// lalala.talk's T3 client, straight from the tab to the visitor's own T3 Code server: pairing-link exchange, a WebSocket
// ticket, and the Effect RPC JSON protocol T3's own clients speak on /ws. T3 already answers
// cross-origin bearer requests (CORS `*`), so no helper or server change is needed.

import { isLocalOrigin, readPairing } from "../../pairing";

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

export const ALLOW_LOCAL_NETWORK =
  "Allow local network in Chrome: answer its prompt next to the address bar.";
export const LOCAL_NETWORK_BLOCKED =
  "Allow local network in Chrome: click the icon left of the address bar, open Site settings, set Local network access to Allow.";

/**
 * Chrome's permission for this page to reach T3 on this computer, or null where none applies (a page
 * served from localhost, or a browser without it). Its `onchange` says when the user answers.
 */
export async function localNetworkPermission(): Promise<PermissionStatus | null> {
  if (LOOPBACK.test(location.hostname)) return null;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      return await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
    } catch {}
  }
  return null;
}

/** What the user has to do in Chrome before this page can reach T3, or null when nothing. */
export const localNetworkProblem = (permission: PermissionStatus | null) =>
  permission?.state === "denied"
    ? LOCAL_NETWORK_BLOCKED
    : permission?.state === "prompt"
      ? ALLOW_LOCAL_NETWORK
      : null;

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
const ADDRESS_KEY = "lalala.t3.address";

/** The T3 address (T3 Connect) this browser pairs through instead of a link's local one; kept on disconnect. */
export function readSavedAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? "";
  } catch {
    return "";
  }
}
export const saveAddress = (address: string) =>
  address === "" ? localStorage.removeItem(ADDRESS_KEY) : localStorage.setItem(ADDRESS_KEY, address);

/** What to say when nothing answers at `origin`. */
const unreachable = (origin: string) =>
  isLocalOrigin(origin)
    ? `Could not reach ${origin}. Is T3 Code running?`
    : `Could not reach ${origin}. Check the address, and that T3 Code is running with T3 Connect on.`;

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

/** Trades a T3 pairing code or link for a bearer session, at `via` instead of the link's own address when given. */
export async function pairWithLink(input: string, via?: string): Promise<Session> {
  const pairing = readPairing(input);
  const origin = via ?? pairing.origin;
  const { token } = pairing;
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
      (isLocalOrigin(origin) ? localNetworkProblem(await localNetworkPermission()) : null) ??
        unreachable(origin),
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(
      result.error === "invalid_grant" || response.status === 401
        ? "That pairing link was already used or expired. Make a new one in T3 Code."
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

  /**
   * Opens the socket. `timeoutMs` bounds each step, so a T3 that never answers fails instead of
   * hanging; leave it out while Chrome's local network prompt may be up, which holds the request.
   */
  async connect(timeoutMs?: number) {
    let ticketResponse: Response;
    try {
      ticketResponse = await localFetch(`${this.session.origin}/api/auth/websocket-ticket/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.session.accessToken}` },
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch {
      const { origin } = this.session;
      throw new Error(
        (isLocalOrigin(origin) ? localNetworkProblem(await localNetworkPermission()) : null) ??
          unreachable(origin),
      );
    }
    if (ticketResponse.status === 401) throw new Error("T3 no longer accepts this pairing: pair again in the settings.");
    if (!ticketResponse.ok) throw new Error(`T3 answered ${ticketResponse.status}.`);
    const { ticket } = await ticketResponse.json();
    const url = new URL("/ws", this.session.origin.replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", String(PROTOCOL));
    url.searchParams.set("wsTicket", ticket);
    const ws = new WebSocket(url);
    this.#ws = ws;
    await new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            ws.close();
            reject(new Error("T3 Code did not answer."));
          }, timeoutMs)
        : undefined;
      ws.addEventListener("open", () => resolve(clearTimeout(timer)), { once: true });
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("The T3 socket failed to open."));
        },
        { once: true },
      );
    });
    ws.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    ws.addEventListener("close", () => {
      clearInterval(this.#ping);
      for (const pending of this.#pending.values()) pending.reject(new Error(SOCKET_CLOSED));
      this.#pending.clear();
      this.onClose();
    });
    this.#ping = setInterval(() => this.#send({ _tag: "Ping" }), 10_000);
  }

  /** Whether requests can go out now (false from the moment it starts closing). */
  get open() {
    return this.#ws?.readyState === WebSocket.OPEN;
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
      if (!this.open) return reject(new Error(SOCKET_CLOSED));
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

export const SOCKET_CLOSED = "T3 socket closed";

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
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  archivedAt?: string | null;
};
export type ThreadShell = { id: string; projectId: string; title: string; updatedAt?: string };
export type Provider = { instanceId: string; name: string; models: { slug: string; name: string }[] };

/** Every project and thread, once. */
export function readShell(socket: T3Socket) {
  return new Promise<{ projects: Project[]; threads: ThreadShell[] }>((resolve, reject) => {
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
  });
}

/** Projects, threads and models once, for the picker. */
export async function readWorkspace(socket: T3Socket) {
  const snapshot = await readShell(socket);
  const config = await socket.request<{
    environment?: { label?: string; serverVersion?: string };
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
    version: config.environment?.serverVersion ?? null,
    projects: snapshot.projects,
    threads: [...snapshot.threads].sort((a, b) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
    ),
    providers,
    defaultModel: config.settings?.defaultModelSelection ?? null,
  };
}

/** How long T3 takes to answer one small request, in ms: the check that the link works. */
export async function pingServer(socket: T3Socket) {
  const startedAt = performance.now();
  await socket.request("server.getConfig", {});
  return Math.round(performance.now() - startedAt);
}

export const LALALA_PROJECT = "lalala";
export const VOICE_THREAD_TITLE = "voice (lalala.talk)";

/**
 * lalala's own project, `~/lalala` on the paired machine (T3 expands `~` and makes the folder),
 * found by its title or made once; an archived one comes back.
 */
export async function ensureLalalaProject(socket: T3Socket, projects: Project[], name = LALALA_PROJECT) {
  const own = projects.filter((p) => p.title === name);
  const live = own.find((p) => !p.archivedAt);
  if (live) return { project: live, created: false };
  const archived = own[0];
  const project = archived
    ? await socket.request<Project>("projects.mutate", {
        type: "project.update",
        commandId: uuid(),
        projectId: archived.id,
        archived: false,
      })
    : await socket.request<Project>("projects.mutate", {
        type: "project.create",
        commandId: uuid(),
        projectId: uuid(),
        title: name,
        workspaceRoot: `~/${name}`,
        createWorkspaceRootIfMissing: true,
      });
  return { project, created: !archived };
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
    title: VOICE_THREAD_TITLE,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  return result.threadId;
}

