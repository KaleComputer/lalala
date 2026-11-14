import * as NodePath from "node:path";
import type { Connect, Plugin } from "vite";

import { cardsDir } from "./cards.mjs";
import { readCanvasLayout, saveCanvasCards } from "./canvasLayout";
import { appendSessionEvents } from "./sessionLog";

/**
 * The app's own `/__lalala/*` routes: the session log, the shared canvas layout and the config.
 * Speech runs in the browser (src/voice/browserSpeech), on every device.
 */
const PREFIX = "/__lalala";
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
