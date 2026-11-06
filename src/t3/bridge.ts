// The standalone's stand-in for T3's client state (apps/web/src/state): the brain thread's shell
// and visible turn items, fed by the dev server's T3 bridge (vite/t3bridge.mjs) over SSE.
import { useSyncExternalStore } from "react";
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

type BridgeState = {
  readonly connected: boolean;
  readonly error: string | null;
  readonly workspaceRoot: string | null;
  readonly shell: Shell | null;
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
};

let state: BridgeState = { connected: false, error: null, workspaceRoot: null, shell: null, rows: [] };
const listeners = new Set<() => void>();
const set = (next: BridgeState) => {
  state = next;
  for (const listener of listeners) listener();
};

function start() {
  const source = new EventSource("/__lalala/t3/events");
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "hello") {
      set({
        connected: event.connected,
        error: event.error,
        workspaceRoot: event.workspaceRoot,
        shell: event.shell,
        rows: event.rows,
      });
    } else if (event.type === "row") {
      const rows = state.rows.filter((row) => row.item.id !== event.row.item.id);
      set({ ...state, rows: [...rows, event.row] });
    } else if (event.type === "active" && state.shell !== null) {
      set({ ...state, shell: { ...state.shell, active: event.value } });
    }
  };
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
