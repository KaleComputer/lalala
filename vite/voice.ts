import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Connect, Plugin } from "vite";

import { cardsDir } from "./cards.mjs";
import { readCanvasLayout, saveCanvasCards } from "./canvasLayout";
import { appendSessionEvents } from "./sessionLog";

/**
 * The app's own `/__lalala/*` routes: the session log, the shared canvas layout, the config, and the
 * computer's speech service (opt-in per task in Settings; speech runs in the browser by default).
 */
const PREFIX = "/__lalala";
// The speech service on this computer (Parakeet + Kokoro on MLX); this server only proxies to it on
// loopback and never starts or stops it.
const SPEECH_PORT = Number(process.env.LALALA_LOCAL_PORT?.trim() || 5797);
const SPEECH = `http://127.0.0.1:${SPEECH_PORT}`;
// Picking "on the computer" in Settings starts the service (scripts/speech.sh, detached so it outlives
// this server); it loads in ~10 s, longer the first time (a venv and ~2.6 GB of models).
const SPEECH_SCRIPT = NodePath.join(import.meta.dirname, "../scripts/speech.sh");
const SPEECH_LOG = NodePath.join(
  process.env.LALALA_SPEECH_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".cache/lalala"),
  `speech-${SPEECH_PORT}.log`,
);
const STARTING_MS = 120_000;
let startedAt = 0;
let failureShown = false;
/**
 * Starts the service unless a start is still within its window. A window that ran out without it
 * answering is reported once (false: the page shows why), and the next ask starts it again: the page
 * never stops asking, at its own backoff.
 */
function startSpeech(force: boolean): boolean {
  const now = Date.now();
  if (!force && startedAt > 0 && now - startedAt < STARTING_MS) return true;
  if (!force && startedAt > 0 && !failureShown) {
    failureShown = true;
    return false;
  }
  failureShown = false;
  startedAt = now;
  NodeChildProcess.spawn(SPEECH_SCRIPT, ["start"], { detached: true, stdio: "ignore" }).unref();
  return true;
}
/** Why the service didn't come up: the last line its log says it failed with, if any. */
function speechFailure(): string {
  try {
    const lines = NodeFS.readFileSync(SPEECH_LOG, "utf8").trim().split("\n").slice(-20);
    const reason = lines.reverse().find((line) => /needs|error|Error|failed|No such file/.test(line));
    return reason?.trim().slice(0, 200) ?? "It didn't start; the log is " + SPEECH_LOG;
  } catch {
    return "It didn't start.";
  }
}
const SPEECH_DOWN = "The computer's speech service isn't running";
// No length limit worth hitting on what the user says: 64 MiB is ~35 min of 16 kHz speech.
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_TTS_CHARS = 1_200;
const EXTRAS_DIR = NodePath.join(import.meta.dirname, "../src/voice/extras") + NodePath.sep;
// The user's cards folder (vite/cards.mjs) swaps in the same way.
const CARDS_DIR =
  cardsDir(process.env.LALALA_WORKSPACE_ROOT?.trim() || NodePath.join(import.meta.dirname, "..")) + NodePath.sep;

// The repo root: the brain's project unless LALALA_WORKSPACE_ROOT names another.
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

async function fetchSpeech(path: string, init: RequestInit = {}, waitMs = 20_000): Promise<Response> {
  try {
    const timeout = AbortSignal.timeout(waitMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return await fetch(`${SPEECH}${path}`, { ...init, signal });
  } catch (error) {
    throw new Error(SPEECH_DOWN, { cause: error });
  }
}

const speechError = (error: unknown) =>
  error instanceof Error && error.message === SPEECH_DOWN ? SPEECH_DOWN : String(error);

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
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
            marks?: unknown;
            state?: unknown;
            follow?: unknown;
            templates?: unknown;
          };
          sendJson(
            res,
            200,
            saveCanvasCards(
              body.cards,
              body.canvases,
              body.placed,
              body.marks,
              body.state,
              body.follow,
              body.templates,
            ),
          );
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

    // The computer's speech service, for the tasks Settings sends there: whether it answers, and its models.
    if (route === "/local/health" && req.method === "GET") {
      fetchSpeech("/health", { signal: AbortSignal.timeout(2_000) })
        .then(async (response) => {
          const body = (await response.json()) as { ready?: unknown; stt?: unknown; tts?: unknown };
          sendJson(res, 200, {
            ready: body.ready === true,
            stt: typeof body.stt === "string" ? body.stt : null,
            tts: typeof body.tts === "string" ? body.tts : null,
          });
        })
        .catch(() => {
          // Not up: a page with a task on the computer starts it ("start=auto"; "start=1" is Try again).
          const start = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("start");
          if (start === null) sendJson(res, 200, { ready: false, off: true });
          else if (startSpeech(start === "1")) sendJson(res, 200, { ready: false, starting: true });
          else sendJson(res, 200, { ready: false, down: true, reason: speechFailure() });
        });
      return;
    }

    if (route === "/local/stt" && req.method === "POST") {
      readBody(req, MAX_AUDIO_BYTES)
        .then(async (audio) => {
          // A second per second of 16 kHz audio on top: a minutes-long turn is chunked and takes longer.
          const response = await fetchSpeech(
            "/stt",
            {
              method: "POST",
              headers: { "content-type": req.headers["content-type"] ?? "audio/wav" },
              body: new Uint8Array(audio),
            },
            20_000 + Math.round(audio.length / 32),
          );
          const body = (await response.json()) as { text?: unknown; error?: unknown };
          if (!response.ok) throw new Error(`speech-to-text: ${String(body.error ?? response.status)}`);
          sendJson(res, 200, { text: typeof body.text === "string" ? body.text.trim() : "" });
        })
        .catch((error: unknown) => sendJson(res, 502, { error: speechError(error) }));
      return;
    }

    if (route === "/local/tts" && req.method === "POST") {
      const aborter = new AbortController();
      res.on("close", () => aborter.abort());
      readBody(req, 64 * 1024)
        .then(async (raw) => {
          const { text } = JSON.parse(raw.toString("utf8")) as { text?: unknown };
          if (typeof text !== "string" || text.trim() === "") throw new Error("no text");
          const response = await fetchSpeech("/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text.slice(0, MAX_TTS_CHARS) }),
            signal: aborter.signal,
          });
          if (!response.ok || response.body === null) {
            throw new Error(`text-to-speech answered ${response.status}`);
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
          else if (!aborter.signal.aborted) sendJson(res, 502, { error: speechError(error) });
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
