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
const LABEL = "t3voice";

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

/** The running T3 server's origin, from its runtime file (read only). */
export function t3Origin() {
  if (process.env.T3VOICE_T3_ORIGIN) return process.env.T3VOICE_T3_ORIGIN.replace(/\/$/, "");
  const file = NodePath.join(T3_HOME, "userdata/server-runtime.json");
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")).origin;
  } catch {
    throw new Error(`T3 Code is not running (no ${file}); start it, or set T3VOICE_T3_ORIGIN`);
  }
}

function readSession() {
  try {
    return JSON.parse(NodeFS.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
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
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: decodeURIComponent(token),
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: LABEL,
    client_device_type: "desktop",
  });
  const response = await fetch(`${t3Origin()}/oauth/token`, {
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
  };
  NodeFS.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  return { scope: session.scope, expiresAt: new Date(session.expiresAt).toISOString() };
}

// T3 has no refresh grant for environment sessions, so renewal is a fresh local pair a week
// before expiry. Running sockets keep their connection; new calls pick up the new token.
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
let renewing = null;

export function renewSessionIfDue() {
  const session = readSession();
  if (!session || session.expiresAt - Date.now() > RENEW_BEFORE_MS) return Promise.resolve(null);
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
  if (!session) throw new Error("not paired yet: run `npm run pair`");
  if (session.expiresAt < Date.now()) throw new Error("T3 session expired: run `npm run pair`");
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
}

function describeCause(cause) {
  const first = Array.isArray(cause) ? cause[0] : undefined;
  if (first?._tag === "Fail") return first.error?.message ?? JSON.stringify(first.error);
  if (first?._tag === "Die") return String(first.defect?.message ?? first.defect);
  return "interrupted";
}

export const uuid = () => NodeCrypto.randomUUID();
