// A small client for T3 Code's public API: pairing-token exchange, a WebSocket ticket, and the
// Effect RPC JSON protocol the web/mobile clients speak on /ws. Only what voice needs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { stateDir } from "./stateDir.mjs";

const T3_HOME = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
const STATE_DIR = stateDir();
const SESSION_FILE = NodePath.join(STATE_DIR, "session.json");
const LABEL = "lalala";

/**
 * The `t3` CLI that mints the pairing token: T3CODE_CLI_PATH, else the launcher the desktop app
 * installs in T3 Code's home, else `t3` on PATH, else `npx t3` (the npm package has the same CLI).
 */
function t3Command() {
  const explicit = process.env.T3CODE_CLI_PATH?.trim();
  if (explicit) return [explicit, []];
  const launcher = NodePath.join(T3_HOME, "bin/t3");
  if (NodeFS.existsSync(launcher)) return [launcher, []];
  try {
    NodeChildProcess.execFileSync("t3", ["--version"], { stdio: "ignore" });
    return ["t3", []];
  } catch {
    return ["npx", ["--yes", "t3"]];
  }
}
const ORCHESTRATION_PROTOCOL = 2;

const RUNTIME_FILE = NodePath.join(T3_HOME, "userdata/server-runtime.json");

/** This machine's running T3 server's origin, from its runtime file (read only). */
function localOrigin() {
  if (process.env.LALALA_T3_ORIGIN) return process.env.LALALA_T3_ORIGIN.replace(/\/$/, "");
  try {
    return JSON.parse(NodeFS.readFileSync(RUNTIME_FILE, "utf8")).origin;
  } catch {
    throw new Error(`T3 Code is not running (no ${RUNTIME_FILE}); start it, or set LALALA_T3_ORIGIN`);
  }
}

/** The paired server: the one a pairing link named, else this machine's. */
export function t3Origin() {
  return readSession()?.origin ?? localOrigin();
}

/** Whether a T3 runs here for `t3 pair`, so the settings can offer pairing with this machine. */
export const canPairLocal = () =>
  Boolean(process.env.LALALA_T3_ORIGIN) || NodeFS.existsSync(RUNTIME_FILE);

function readSession() {
  try {
    return JSON.parse(NodeFS.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function exchange(origin, token, source) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: LABEL,
    client_device_type: "desktop",
  });
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(`token exchange answered ${response.status}: ${result.error ?? result.code ?? ""}`);
  }
  NodeFS.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const session = {
    accessToken: result.access_token,
    scope: result.scope,
    expiresAt: Date.now() + Number(result.expires_in) * 1000,
    source,
    // A local pairing follows this machine's T3 wherever its port moves.
    ...(source === "link" ? { origin } : {}),
  };
  NodeFS.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  return { scope: session.scope, expiresAt: new Date(session.expiresAt).toISOString() };
}

/** Pairs with the server a T3 pairing link (`https://host/pair#token=…`) names. */
export function pairWithLink(link) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw new Error("That is not a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Not an http(s) link");
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new Error("The link has no pairing token");
  return exchange(url.origin, token, "link");
}

/** Pairs with this machine's T3 (the one `t3Origin` finds) using a bare code from T3 Code's Copy code. */
export function pairWithCode(code) {
  const token = String(code).trim();
  if (!token) throw new Error("The code is empty");
  return exchange(localOrigin(), token, "local");
}

/** Forgets the stored session; T3 Code's Connections settings can revoke it on the server. */
export function forgetSession() {
  NodeFS.rmSync(SESSION_FILE, { force: true });
}

/** What the settings show about the pairing; never the token. */
export function sessionInfo() {
  const session = readSession();
  if (!session) return null;
  let origin = null;
  try {
    origin = t3Origin();
  } catch {}
  return {
    origin,
    expiresAt: session.expiresAt,
    renews: session.source !== "link",
  };
}

/**
 * Mints a one-time pairing token with `t3 pair` (only the two orchestration scopes voice needs),
 * exchanges it for a bearer session, and stores that in a 0600 file. Nothing is printed.
 */
export async function pair() {
  const [command, prefix] = t3Command();
  const out = NodeChildProcess.execFileSync(
    command,
    [
      ...prefix,
      "pair",
      "--base-dir",
      T3_HOME,
      "--ttl",
      "5m",
      "--label",
      LABEL,
      "--scope",
      "orchestration:read",
      "--scope",
      "orchestration:operate",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const token = /token=([^\s&#]+)/.exec(out)?.[1];
  if (!token) throw new Error("could not read a pairing token from `t3 pair`");
  return exchange(localOrigin(), decodeURIComponent(token), "local");
}

// T3 has no refresh grant for environment sessions, so renewal is a fresh local pair a week
// before expiry. Running sockets keep their connection; new calls pick up the new token.
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
let renewing = null;

export function renewSessionIfDue() {
  const session = readSession();
  // Only a local pairing can mint its own successor; a linked one is paired again by hand.
  if (!session || session.source === "link" || session.expiresAt - Date.now() > RENEW_BEFORE_MS) {
    return Promise.resolve(null);
  }
  renewing ??= pair()
    .then((result) => {
      console.log(`t3 session renewed, valid until ${result.expiresAt}`);
      return result;
    })
    .catch((error) => {
      console.error(`t3 session renewal failed: ${error.message}`);
      return null;
    })
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

/** Checks now and every few hours, so a long-running server never reaches expiry. */
export function keepSessionFresh() {
  void renewSessionIfDue();
  setInterval(() => void renewSessionIfDue(), 6 * 60 * 60 * 1000).unref();
}

function bearer() {
  const session = readSession();
  if (!session) throw new Error("Not paired yet");
  if (session.expiresAt < Date.now()) throw new Error("The T3 session expired; pair again");
  void renewSessionIfDue();
  return { authorization: `Bearer ${session.accessToken}` };
}

export async function getJson(path) {
  const response = await fetch(`${t3Origin()}${path}`, {
    headers: { ...bearer(), "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL) },
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/** One RPC socket to T3. `request` resolves with the Exit's value; `stream` calls back per chunk. */
export class T3Socket {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #ping = null;
  onClose = () => {};

  async connect() {
    const ticketResponse = await fetch(`${t3Origin()}/api/auth/websocket-ticket/rpc`, {
      method: "POST",
      headers: bearer(),
    });
    if (!ticketResponse.ok) throw new Error(`websocket ticket answered ${ticketResponse.status}`);
    const { ticket } = await ticketResponse.json();
    const url = new URL("/ws", t3Origin().replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL));
    url.searchParams.set("wsTicket", ticket);
    const ws = new WebSocket(url);
    this.#ws = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("T3 socket failed to open")), {
        once: true,
      });
    });
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => {
      clearInterval(this.#ping);
      for (const pending of this.#pending.values()) pending.reject(new Error("T3 socket closed"));
      this.#pending.clear();
      this.onClose();
    });
    this.#ping = setInterval(() => this.#send({ _tag: "Ping" }), 10_000);
  }

  close() {
    this.#ws?.close();
  }

  #send(message) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const pending = this.#pending.get(String(message.requestId));
    if (message._tag === "Chunk" && pending) {
      for (const value of message.values) pending.onChunk?.(value);
      this.#send({ _tag: "Ack", requestId: message.requestId });
    } else if (message._tag === "Exit" && pending) {
      this.#pending.delete(String(message.requestId));
      if (message.exit._tag === "Success") pending.resolve(message.exit.value);
      else pending.reject(new Error(describeCause(message.exit.cause)));
    } else if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
      console.error(`t3: ${message._tag}`, JSON.stringify(message).slice(0, 300));
    }
  }

  #call(tag, payload, onChunk) {
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onChunk });
      this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  request(tag, payload) {
    return this.#call(tag, payload);
  }

  stream(tag, payload, onChunk) {
    return this.#call(tag, payload, onChunk);
  }

  /** A subscription's first snapshot; the subscription stops there. */
  snapshot(tag, payload) {
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        reject,
        resolve: () => reject(new Error(`${tag} ended without a snapshot`)),
        onChunk: (chunk) => {
          if (chunk.kind !== "snapshot") return;
          this.#pending.delete(id);
          this.#send({ _tag: "Interrupt", requestId: id, interruptors: [] });
          resolve(chunk.snapshot);
        },
      });
      this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }
}

function describeCause(cause) {
  const first = Array.isArray(cause) ? cause[0] : undefined;
  if (first?._tag === "Fail") return first.error?.message ?? JSON.stringify(first.error);
  if (first?._tag === "Die") return String(first.defect?.message ?? first.defect);
  return "interrupted";
}

export const uuid = () => NodeCrypto.randomUUID();
