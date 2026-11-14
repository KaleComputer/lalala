import { useSyncExternalStore } from "react";

import { REQUEST_TIMEOUT_MS } from "./voiceErrors";

/**
 * Whether the voice can reach T3 Code. Inside T3 it always can (the route 404s); the standalone asks
 * its bridge, again while the page is visible, so the bar follows T3 coming and going.
 */
export type T3Link = "unknown" | "connected" | "disconnected";

const ROUTE = "/__lalala/t3/connection";
const RECHECK_MS = 15_000;

let link: T3Link = "unknown";
let inside = false;
let timer = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const set = (next: T3Link) => {
  if (next === link) return;
  link = next;
  for (const listener of listeners) listener();
};

async function read(): Promise<void> {
  try {
    const response = await fetch(ROUTE, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      inside = true;
      return set("connected");
    }
    const c = (await response.json()) as { paired?: boolean; connected?: boolean };
    set(c.paired === true && c.connected === true ? "connected" : "disconnected");
  } catch {
    set("disconnected");
  }
}

/** Reads the link now; the settings call it after pairing or disconnecting. */
export function refreshT3Link(): Promise<void> {
  loading ??= read().finally(() => {
    loading = null;
  });
  return loading;
}

const schedule = () => {
  window.clearTimeout(timer);
  if (inside || listeners.size === 0 || document.visibilityState !== "visible") return;
  timer = window.setTimeout(() => void refreshT3Link().then(schedule), RECHECK_MS);
};

const onVisible = () => {
  if (document.visibilityState === "visible" && !inside) void refreshT3Link();
  schedule();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisible);
    void refreshT3Link().then(schedule);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisible);
    window.clearTimeout(timer);
  };
}

export const useT3Link = () => useSyncExternalStore(subscribe, () => link);
