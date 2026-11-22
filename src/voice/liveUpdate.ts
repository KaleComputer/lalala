// Modules that apply their own hot update without remounting the voice host.
const LIVE = ["/src/voice/extras/", "/src/voice/extrasImages.ts", "/src/voice/voiceThemeSync.ts"];

/**
 * Whether a hot update applies in place during a call: CSS, extras/ and the user's cards (served
 * under `cardsUrl`, vite/cards.mjs). Anything else is a change to lalala's own code.
 */
export function appliesLive(path: string, cardsUrl: string | undefined): boolean {
  const file = path.split("?")[0] ?? path;
  return (
    file.endsWith(".css") ||
    LIVE.some((prefix) => file.startsWith(prefix)) ||
    (cardsUrl !== undefined && file.startsWith(cardsUrl))
  );
}

/**
 * Whether Vite's client reloads this page for a full reload: an .html path (a brain card written
 * into the served folder) only when it is this page's own.
 */
export function reloadsPage(path: string | undefined, pathname: string): boolean {
  if (!path?.endsWith(".html")) return true;
  const page = decodeURI(pathname);
  return (
    page === path ||
    path === "/index.html" ||
    (page.endsWith("/") && `${page}index.html` === path)
  );
}

export interface HmrUpdateItem {
  readonly path: string;
}

export interface HmrImportArg {
  readonly acceptedPath: string;
  readonly timestamp: number;
  readonly explicitImportRequired?: boolean;
  readonly isWithinCircularImport?: boolean;
}

export interface HmrClientLike {
  importUpdatedModule?: (arg: HmrImportArg) => Promise<unknown>;
}

export interface HmrHotLike {
  on(event: "vite:beforeUpdate", cb: (payload: { updates: HmrUpdateItem[] }) => void): void;
  on(event: "vite:beforeFullReload", cb: (payload: { path?: string }) => void): void;
  on(event: "vite:ws:disconnect", cb: (payload: { webSocket?: { url?: string } }) => unknown): void;
  readonly hmrClient?: HmrClientLike;
}

/**
 * Decides whether a full-reload payload should reload the page right now or be held until the
 * active call ends. Used on the reconnected HMR socket (hmrReconnect.ts) as a second line of
 * defense behind `vite:beforeFullReload`.
 */
export function handleHmrFullReload(options: {
  readonly path: string | undefined;
  readonly pathname: string;
  readonly callActive: () => boolean;
  readonly hold: (what: string) => void;
  readonly reload: () => void;
}): boolean {
  if (!reloadsPage(options.path, options.pathname)) return false;
  if (options.callActive()) {
    options.hold(options.path ?? "full reload");
    return false;
  }
  options.reload();
  return true;
}

export interface HmrCallGuardOptions {
  readonly hot: HmrHotLike;
  readonly callActive: () => boolean;
  readonly voiceIdle: () => boolean;
  readonly cardsUrl: () => string | undefined;
  readonly pathname: () => string;
  readonly onHold: (what: string) => void;
  readonly onReload: (why: string) => void;
  readonly clearErrorOverlays: () => void;
  /** Installs in-place HMR socket reconnect; when false, the guard handles disconnect reloads too. */
  readonly keepAcrossDisconnects: (guard: {
    readonly callActive: () => boolean;
    readonly hold: (what: string) => void;
    readonly clearErrorOverlays: () => void;
  }) => boolean;
  /** Polls until the server answers again (only used when keepAcrossDisconnects returns false). */
  readonly waitForServer?: (socketUrl?: string) => Promise<void>;
  readonly pollMs?: number;
  readonly setIntervalFn?: (cb: () => void, ms: number) => number;
  readonly clearIntervalFn?: (id: number) => void;
}

/**
 * Guards every Vite dev HMR reload path so an active voice call (connecting, listening, thinking,
 * speaking, or speech model loading) is never interrupted by an automatic page reload.
 * Updates and reloads are deferred to a passive update chip and only auto-reload once the call
 * ends and the page is idle.
 */
export function installHmrCallGuard(options: HmrCallGuardOptions): { readonly hold: (what: string) => void } {
  const pollMs = options.pollMs ?? 1_000;
  const setIntervalFn = options.setIntervalFn ?? ((cb, ms) => window.setInterval(cb, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((id) => window.clearInterval(id));

  let waiting: Promise<void> | null = null;
  const whenIdle = (): Promise<void> => {
    if (waiting !== null) return waiting;
    waiting = new Promise<void>((resolve) => {
      const timer = setIntervalFn(() => {
        if (!options.voiceIdle()) return;
        clearIntervalFn(timer);
        waiting = null;
        resolve();
      }, pollMs);
    });
    return waiting;
  };

  let held = false;
  const reloadWhenIdle = (): void => {
    void whenIdle().then(() => {
      // Re-verify synchronously right before reload in case a new call started on the same tick.
      if (!options.voiceIdle()) {
        reloadWhenIdle();
        return;
      }
      options.onReload("held dev update, voice off");
    });
  };

  const hold = (what: string): void => {
    if (held) return;
    held = true;
    options.onHold(what);
    reloadWhenIdle();
  };

  options.hot.on("vite:beforeUpdate", (payload) => {
    if (!options.callActive()) return;
    // Vite's client reloads on the first HMR update if a <vite-error-overlay> is mounted
    // (clearOverlayOrReloadOnFirstUpdate), even for a live card edit or an emptied update list.
    options.clearErrorOverlays();
    const cardsUrl = options.cardsUrl();
    const now = payload.updates.filter((update) => appliesLive(update.path, cardsUrl));
    if (now.length === payload.updates.length) return;
    const blocked = payload.updates.filter((update) => !appliesLive(update.path, cardsUrl));
    hold(blocked.map((update) => update.path).join(", "));
    payload.updates.splice(0, payload.updates.length, ...now);
  });

  options.hot.on("vite:beforeFullReload", (payload) => {
    if (!options.callActive() || !reloadsPage(payload.path, options.pathname())) return;
    hold(payload.path ?? "full reload");
    // Vite's client reloads for an .html path only when it matches this page.
    payload.path = "/__lalala-held.html";
  });

  // Vite's importUpdatedModule calls pageReload() directly if a circular-import HMR import fails,
  // bypassing vite:beforeFullReload. Suppress that auto-reload during an active call.
  const hmrClient = options.hot.hmrClient;
  if (hmrClient && typeof hmrClient.importUpdatedModule === "function") {
    const originalImport = hmrClient.importUpdatedModule.bind(hmrClient);
    hmrClient.importUpdatedModule = async (arg) => {
      if (!options.callActive() || !arg.isWithinCircularImport) return originalImport(arg);
      try {
        return await originalImport({ ...arg, isWithinCircularImport: false });
      } catch (error) {
        hold(arg.acceptedPath);
        throw error;
      }
    };
  }

  // A locked phone or app switch drops Vite's HMR socket and Vite's client reloads once the server
  // answers again; hmrReconnect reconnects in place instead. If Vite's client shape ever changes
  // and keepAcrossDisconnects returns false, never allow a disconnect reload during a call—even if
  // the call started while the server was unreachable.
  const kept = options.keepAcrossDisconnects({
    callActive: options.callActive,
    hold,
    clearErrorOverlays: options.clearErrorOverlays,
  });
  if (!kept) {
    options.hot.on("vite:ws:disconnect", (payload) => {
      if (options.callActive()) {
        hold("server reconnect");
        return new Promise<never>(() => {});
      }
      if (!options.waitForServer) return undefined;
      return options.waitForServer(payload?.webSocket?.url).then(() => {
        if (options.callActive() || !options.voiceIdle()) {
          hold("server reconnect");
          return new Promise<never>(() => {});
        }
        return undefined;
      });
    });
  }

  return { hold };
}
