import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import type { Connect, Plugin } from "vite";

import { cardsDir } from "./cards.mjs";
import { readCanvasLayout, saveCanvasCards } from "./canvasLayout";
import { appendSessionEvents } from "./sessionLog";

/**
 * Speech endpoints for lalala: the browser only talks to `/__lalala/*` on its own origin; these
 * (incl. the realtime STT socket) go to the local speech service (`scripts/speech.sh`) on loopback.
 */
const LOCAL_PORT = Number(process.env.LALALA_LOCAL_PORT?.trim() || 5797);
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const LOCAL_DOWN = "Local speech down · run npm run speech";
const PREFIX = "/__lalala";
// No length limit on what the user says: 1 GiB is ~9 h of 16 kHz speech.
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
const MAX_TTS_CHARS = 1_200;
const EXTRAS_DIR = NodePath.join(import.meta.dirname, "../src/voice/extras") + NodePath.sep;
// The user's cards folder (vite/cards.mjs) swaps in the same way.
const CARDS_DIR =
  cardsDir(process.env.LALALA_WORKSPACE_ROOT?.trim() || NodePath.join(import.meta.dirname, "..")) + NodePath.sep;

// The repo root: the brain's project, and where scripts/speech.sh lives.
const workspaceRoot = NodePath.resolve(import.meta.dirname, "..");

function readBody(req: Connect.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const describe = (error: unknown): string =>
  error instanceof Error && error.cause !== undefined
    ? `${error.message}: ${String(error.cause)}`
    : String(error);

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function fetchLocal(path: string, init: RequestInit): Promise<Response> {
  try {
    const timeout = AbortSignal.timeout(20_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return await fetch(`${LOCAL}${path}`, { ...init, signal });
  } catch (error) {
    throw new Error(LOCAL_DOWN, { cause: error });
  }
}

async function transcribeLocal(audio: Buffer, contentType: string): Promise<string> {
  const response = await fetchLocal("/stt", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(audio),
  });
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (!response.ok)
    throw new Error(`local speech-to-text: ${String(body.error ?? response.status)}`);
  return typeof body.text === "string" ? body.text.trim() : "";
}

// Picking local AI starts the service if it is not up (detached, so it outlives Vite restarts).
// It loads in ~10 s; a start that has not answered within STARTING_MS reports "down".
const STARTING_MS = 45_000;
const START_AGAIN_AFTER_MS = 5 * 60_000;
let lastStartAt = 0;
function startingLocalSpeech(): boolean {
  if (Date.now() - lastStartAt >= START_AGAIN_AFTER_MS) {
    lastStartAt = Date.now();
    const script = NodePath.join(workspaceRoot, "scripts/speech.sh");
    NodeChildProcess.spawn(script, ["start"], { detached: true, stdio: "ignore" }).unref();
  }
  return Date.now() - lastStartAt < STARTING_MS;
}

const localError = (error: unknown): string =>
  error instanceof Error && error.message === LOCAL_DOWN ? LOCAL_DOWN : describe(error);

/** Pipes the browser's realtime STT socket to the local service, like a reverse proxy would. */
function proxyLocalSocket(
  req: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) {
  const upstream = NodeNet.connect(LOCAL_PORT, "127.0.0.1", () => {
    const lines = Object.entries(req.headers).flatMap(([name, value]) =>
      name === "host" ? [] : (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
    );
    upstream.write(
      `GET /stt/stream HTTP/1.1\r\nhost: 127.0.0.1:${LOCAL_PORT}\r\n${lines.join("\r\n")}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export function lalalaPlugin(): Plugin {
  let serverPort = 0;
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith(`${PREFIX}/`)) return next();
    const route = url.slice(PREFIX.length).split("?")[0];

    // The page's session events (voiceLog.ts): one JSON line each, never audio.
    if (route === "/log" && req.method === "POST") {
      readBody(req, 512 * 1024)
        .then((raw) => {
          const written = appendSessionEvents(JSON.parse(raw.toString("utf8")), serverPort);
          sendJson(res, 200, { written });
        })
        .catch(() => sendJson(res, 400, { error: "bad log batch" }));
      return;
    }

    // The canvas's shared card layout (canvasLayout.ts): the Mac and the phone both read and save it.
    if (route === "/canvas" && req.method === "GET") {
      sendJson(res, 200, readCanvasLayout());
      return;
    }
    if (route === "/canvas" && req.method === "POST") {
      readBody(req, 256 * 1024)
        .then((raw) => {
          const body = JSON.parse(raw.toString("utf8")) as {
            cards?: unknown;
            canvases?: unknown;
            placed?: unknown;
          };
          sendJson(res, 200, saveCanvasCards(body.cards, body.canvases, body.placed));
        })
        .catch(() => sendJson(res, 400, { error: "bad canvas layout" }));
      return;
    }

    if (route === "/config" && req.method === "GET") {
      sendJson(res, 200, {
        workspaceRoot: process.env.LALALA_WORKSPACE_ROOT?.trim() || workspaceRoot,
        model: process.env.LALALA_MODEL?.trim() || null,
      });
      return;
    }

    if (route === "/local/health" && req.method === "GET") {
      fetch(`${LOCAL}/health`, { signal: AbortSignal.timeout(2_000) })
        .then(async (response) => {
          const body = (await response.json()) as { ready?: unknown };
          if (body.ready === true) sendJson(res, 200, { ready: true });
          else sendJson(res, 503, { error: "Local speech is still loading its models" });
        })
        .catch(() => {
          const error = startingLocalSpeech() ? "Local speech is starting…" : LOCAL_DOWN;
          sendJson(res, 503, { error });
        });
      return;
    }

    if (route === "/stt" && req.method === "POST") {
      readBody(req, MAX_AUDIO_BYTES)
        .then((audio) => transcribeLocal(audio, req.headers["content-type"] ?? "audio/wav"))
        .then((text) => sendJson(res, 200, { text }))
        .catch((error: unknown) => sendJson(res, 502, { error: localError(error) }));
      return;
    }

    if (route === "/tts" && req.method === "POST") {
      const aborter = new AbortController();
      res.on("close", () => aborter.abort());
      readBody(req, 64 * 1024)
        .then(async (raw) => {
          const { text } = JSON.parse(raw.toString("utf8")) as { text?: unknown };
          if (typeof text !== "string" || text.trim() === "") throw new Error("no text");
          const response = await fetchLocal("/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text.slice(0, MAX_TTS_CHARS) }),
            signal: aborter.signal,
          });
          if (!response.ok || response.body === null) {
            throw new Error(`local text-to-speech answered ${response.status}`);
          }
          // Raw 16-bit 24 kHz PCM.
          res.statusCode = 200;
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("cache-control", "no-store");
          for await (const chunk of response.body) res.write(chunk);
          res.end();
        })
        .catch((error: unknown) => {
          if (res.headersSent) res.end();
          else if (!aborter.signal.aborted) sendJson(res, 502, { error: localError(error) });
        });
      return;
    }

    sendJson(res, 404, { error: "unknown voice route" });
  };

  return {
    name: "t3code:voice",
    apply: "serve",
    configureServer(server) {
      serverPort = server.config.server.port ?? 0;
      server.middlewares.use(handle);
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url?.split("?")[0] === `${PREFIX}/local/stt`) proxyLocalSocket(req, socket, head);
      });
    },
    // A file no extras module imports any more has no HMR boundary; Vite would reload the page and end the call.
    hotUpdate({ file, modules, timestamp }) {
      if (this.environment.name !== "client") return;
      if (!file.startsWith(EXTRAS_DIR) && !file.startsWith(CARDS_DIR)) return;
      const orphans = modules.filter((mod) => mod.importers.size === 0 && !mod.isSelfAccepting);
      if (orphans.length === 0) return;
      const seen = new Set<(typeof modules)[number]>();
      for (const mod of orphans) {
        this.environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
      }
      return modules.filter((mod) => !orphans.includes(mod));
    },
  };
}
