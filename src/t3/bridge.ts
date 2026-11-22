// The standalone's stand-in for T3's client state (apps/web/src/state): the brain thread's shell
// and visible turn items, fed by the dev server's T3 bridge (vite/t3bridge.mjs) over SSE.
import { useSyncExternalStore } from "react";
import type { AgentRun } from "../voice/agents/model";
import {
  type BridgeEvent,
  type BridgeState,
  INITIAL_BRIDGE_STATE,
  reduceBridgeState,
  type SecretAsk,
} from "./bridgeState";

export type { AgentRun, BridgeEvent, BridgeState, SecretAsk };
export { INITIAL_BRIDGE_STATE, reduceBridgeState };

export const ENVIRONMENT_ID = "standalone";
export const PROJECT_ID = "standalone-project";

let state: BridgeState = INITIAL_BRIDGE_STATE;
const listeners = new Set<() => void>();
const set = (next: BridgeState) => {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
};

function onEvent(event: BridgeEvent) {
  set(reduceBridgeState(state, event));
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

declare global {
  /** Read/subscribe handle for extras/AgentMonitorCard (extras/ may not import from src/t3). */
  var __lalalaAgents:
    | {
        readonly get: () => ReadonlyArray<AgentRun>;
        readonly subscribe: (listener: () => void) => () => void;
      }
    | undefined;
}
if (typeof window !== "undefined") {
  globalThis.__lalalaAgents = {
    get: () => state.agents,
    subscribe,
  };
}

export function useBridge<T>(select: (state: BridgeState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const bridgeState = () => state;
