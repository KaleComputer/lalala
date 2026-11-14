// The standalone's stand-in for T3's client state (apps/web/src/state): the brain thread's shell
// and visible turn items, fed by the dev server's T3 bridge (vite/t3bridge.mjs) over SSE.
import { useSyncExternalStore } from "react";
import type { VoiceBrainContext } from "../voice/brainCompaction";
import type { OrchestrationV2ProjectedTurnItem } from "./contracts";

export const ENVIRONMENT_ID = "standalone";
export const PROJECT_ID = "standalone-project";

type Shell = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly active: boolean;
};

/** A secret card (T3's `request_secret`) waiting in some thread. Never the value. */
export type SecretAsk = {
  readonly threadId: string;
  readonly turnItemId: string;
  readonly thread: string;
  readonly label: string;
  readonly reason: string;
  readonly placeholder: string | null;
  readonly file: boolean;
};

type BridgeState = {
  readonly connected: boolean;
  readonly error: string | null;
  readonly workspaceRoot: string | null;
  readonly shell: Shell | null;
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly context: VoiceBrainContext | null;
  readonly asks: ReadonlyArray<SecretAsk>;
};

let state: BridgeState = {
  connected: false,
  error: null,
  workspaceRoot: null,
  shell: null,
  rows: [],
  context: null,
  asks: [],
};
const listeners = new Set<() => void>();
const set = (next: BridgeState) => {
  state = next;
  for (const listener of listeners) listener();
};

function onEvent(event: {
  type: string;
  connected: boolean;
  error: string | null;
  workspaceRoot: string | null;
  shell: Shell | null;
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  row: OrchestrationV2ProjectedTurnItem;
  asks?: ReadonlyArray<SecretAsk>;
  value: boolean;
  context?: VoiceBrainContext | null;
}) {
  if (event.type === "hello") {
    set({
      connected: event.connected,
      error: event.error,
      workspaceRoot: event.workspaceRoot,
      shell: event.shell,
      rows: event.rows,
      context: event.context ?? null,
      asks: event.asks ?? [],
    });
  } else if (event.type === "row") {
    const rows = state.rows.filter((row) => row.item.id !== event.row.item.id);
    set({ ...state, rows: [...rows, event.row] });
  } else if (event.type === "asks") {
    set({ ...state, asks: event.asks ?? [] });
  } else if (event.type === "context") {
    set({ ...state, context: event.context ?? null });
  } else if (event.type === "active" && state.shell !== null) {
    set({ ...state, shell: { ...state.shell, active: event.value } });
  }
}

// The bridge pings every 10 s. A restart behind the phone's front door can leave the stream open
// and silent forever (every reply lost until a reload), so a quiet stream is reopened; so is
// one the browser closed for good (the front door's 502 while lalala restarts).
const STALE_AFTER_MS = 25_000;
const CHECK_EVERY_MS = 5_000;
const REOPEN_AFTER_MS = 2_000;

let source: EventSource | null = null;
let lastEventAt = 0;
let reopenTimer = 0;

function open() {
  window.clearTimeout(reopenTimer);
  source?.close();
  lastEventAt = Date.now();
  const next = new EventSource("/__lalala/t3/events");
  source = next;
  next.onerror = () => {
    if (source !== next || next.readyState !== EventSource.CLOSED) return;
    window.clearTimeout(reopenTimer);
    reopenTimer = window.setTimeout(open, REOPEN_AFTER_MS);
  };
  next.onmessage = (message) => {
    if (source !== next) return;
    lastEventAt = Date.now();
    onEvent(JSON.parse(message.data));
  };
}

function reopenIfStale() {
  if (Date.now() - lastEventAt > STALE_AFTER_MS) open();
}

function start() {
  // lalala.talk's tab follows T3 itself (the harness adapter); the app hears its dev server's bridge.
  const harness = globalThis.__lalalaAdapters?.harness;
  if (harness) return void harness.events((event) => onEvent(event as never));
  open();
  window.setInterval(reopenIfStale, CHECK_EVERY_MS);
  // A backgrounded phone runs no timers; coming back checks at once.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reopenIfStale();
  });
}
if (typeof window !== "undefined") start();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useBridge<T>(select: (state: BridgeState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const bridgeState = () => state;
