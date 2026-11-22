/**
 * Pin state for the canvas Agent Monitor card (`agent-monitor`): shared via localStorage and a
 * DOM event so both the device bar's AgentsTab and extras/AgentMonitorCard stay in sync across the
 * extras bundle boundary without importing across it.
 */
import { useSyncExternalStore } from "react";

export const AGENT_MONITOR_CARD_ID = "agent-monitor";
export const AGENT_MONITOR_STORAGE_KEY = "lalala:agent-monitor-pinned";
export const AGENT_MONITOR_EVENT = "lalala:agent-monitor";

export type AgentMonitorPin = {
  readonly pinned: boolean;
  readonly canvas?: string;
};

const UNPINNED: AgentMonitorPin = { pinned: false };

function read(): AgentMonitorPin {
  if (typeof localStorage === "undefined") return UNPINNED;
  try {
    const raw = localStorage.getItem(AGENT_MONITOR_STORAGE_KEY);
    if (!raw || raw === "0" || raw === "false") return UNPINNED;
    if (raw === "1" || raw === "true") return { pinned: true };
    const parsed = JSON.parse(raw) as { pinned?: unknown; canvas?: unknown } | null;
    if (parsed && parsed.pinned === true) {
      return typeof parsed.canvas === "string" && parsed.canvas !== ""
        ? { pinned: true, canvas: parsed.canvas }
        : { pinned: true };
    }
    return UNPINNED;
  } catch {
    return UNPINNED;
  }
}

let cached: AgentMonitorPin = read();

export const readAgentMonitorPin = (): AgentMonitorPin => cached;

export function setAgentMonitorPinned(pinned: boolean, canvas?: string) {
  const next: AgentMonitorPin = pinned
    ? canvas && canvas !== ""
      ? { pinned: true, canvas }
      : { pinned: true }
    : UNPINNED;
  cached = next;
  try {
    if (next.pinned) localStorage.setItem(AGENT_MONITOR_STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(AGENT_MONITOR_STORAGE_KEY);
  } catch {
    // No storage: stays pinned for this visit only.
  }
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event(AGENT_MONITOR_EVENT));
  }
}

const subscribe = (listener: () => void) => {
  const refresh = () => {
    cached = read();
    listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === AGENT_MONITOR_STORAGE_KEY) refresh();
  };
  document.addEventListener(AGENT_MONITOR_EVENT, refresh);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(AGENT_MONITOR_EVENT, refresh);
    window.removeEventListener("storage", onStorage);
  };
};

export const useAgentMonitorPin = () =>
  useSyncExternalStore(subscribe, readAgentMonitorPin, () => UNPINNED);
