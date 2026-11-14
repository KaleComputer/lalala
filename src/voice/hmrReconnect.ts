import type { HotPayload, Update } from "vite";

import { markUpdateReady } from "./phoneUpdate";
import { voiceLog } from "./voiceLog";

// A locked phone drops the dev server's HMR socket, and Vite's client then reloads the page as soon
// as the server answers again: every unlock outside a call reloaded the canvas. This reconnects in
// place instead and never lets that reload run. Code changed while away shows the update chip.

// The parts of Vite's HMR client a reconnect drives (vite/dist/client/client.mjs, Vite 8).
interface HmrClient {
  transport: { connect(onMessage: (payload: HotPayload) => void): Promise<void> };
  notifyListeners(event: string, data: unknown): Promise<void>;
  queueUpdate(update: Update): Promise<void>;
  prunePaths(paths: string[]): Promise<void>;
}

// The dev server's count of source changes (vite/devVersion.mjs); null where it has none.
type DevVersion = { boot: string; seq: number } | null;
let seen: DevVersion = null;
const devVersion = async (): Promise<DevVersion> => {
  try {
    const response = await fetch("/__lalala/dev-version", { cache: "no-store" });
    return response.ok ? ((await response.json()) as DevVersion) : null;
  } catch {
    return null;
  }
};
const remember = () => void devVersion().then((version) => (seen = version));

let connected = false;
let refresh: number | undefined;
let queue = Promise.resolve();

/** False when this Vite has no HMR client to drive; the caller keeps Vite's own reload then. */
export function keepHmrAcrossDisconnects(hot: NonNullable<ImportMeta["hot"]>): boolean {
  const client = (hot as unknown as { hmrClient?: HmrClient }).hmrClient;
  if (!client?.transport) return false;
  hot.on("vite:ws:disconnect", ({ webSocket }) => {
    void reconnect(client, webSocket.url);
    // Vite awaits this listener before its ping-then-reload.
    return new Promise<never>(() => {});
  });
  remember();
  return true;
}

// What Vite's own handleMessage does, for the socket it no longer owns.
function handle(client: HmrClient, payload: HotPayload): void {
  if (payload.type === "custom") {
    if (payload.event === "vite:ws:connect") connected = true;
    if (payload.event === "vite:ws:disconnect") connected = false;
    // Not queued: the disconnect listener never settles.
    void client.notifyListeners(payload.event, payload.data);
    return;
  }
  if (payload.type === "update" || payload.type === "full-reload" || payload.type === "prune") {
    window.clearTimeout(refresh);
    refresh = window.setTimeout(remember, 1_000);
  }
  queue = queue.then(async () => {
    if (payload.type === "update") {
      await client.notifyListeners("vite:beforeUpdate", payload);
      await Promise.all(
        payload.updates.map((update) =>
          update.type === "js-update" ? client.queueUpdate(update) : swapStylesheet(update),
        ),
      );
      await client.notifyListeners("vite:afterUpdate", payload);
    } else if (payload.type === "full-reload") {
      if (payload.ifFallback) return;
      await client.notifyListeners("vite:beforeFullReload", payload);
      const path = payload.path;
      if (!path?.endsWith(".html") || path === "/index.html" || path === location.pathname) {
        window.location.reload();
      }
    } else if (payload.type === "prune") {
      await client.notifyListeners("vite:beforePrune", payload);
      await client.prunePaths(payload.paths);
    } else if (payload.type === "error") {
      console.error("[vite]", payload.err.message);
    }
  }, console.error);
}

function swapStylesheet(update: Update): Promise<void> {
  const path = update.path.split("?")[0] ?? update.path;
  const link = Array.from(document.querySelectorAll("link")).find(
    (el) => el.href !== "" && new URL(el.href).pathname === path,
  );
  if (!link) return Promise.resolve();
  return new Promise((resolve) => {
    const next = link.cloneNode() as HTMLLinkElement;
    next.href = `${path}?t=${update.timestamp}`;
    const done = () => {
      link.remove();
      resolve();
    };
    next.addEventListener("load", done);
    next.addEventListener("error", done);
    link.after(next);
  });
}

const visible = () =>
  document.visibilityState === "visible"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const on = () => {
          if (document.visibilityState !== "visible") return;
          document.removeEventListener("visibilitychange", on);
          resolve();
        };
        document.addEventListener("visibilitychange", on);
      });

const ping = (url: string) =>
  new Promise<boolean>((resolve) => {
    const socket = new WebSocket(url, "vite-ping");
    socket.addEventListener("open", () => {
      resolve(true);
      socket.close();
    });
    socket.addEventListener("error", () => resolve(false));
  });

async function reconnect(client: HmrClient, socketUrl: string): Promise<void> {
  const url = new URL(socketUrl);
  url.search = "";
  for (;;) {
    await visible();
    if (await ping(url.href)) break;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  await client.transport.connect((payload) => handle(client, payload)).catch(() => {});
  const before = seen;
  seen = await devVersion();
  // A connect that failed leaves Vite's transport marked connected, so no hot update arrives again.
  const missed =
    !connected ||
    (before !== null && (seen === null || seen.boot !== before.boot || seen.seq !== before.seq));
  voiceLog("system", "hmr.reconnected", { connected, missed });
  if (missed) markUpdateReady();
}
