import { useSyncExternalStore } from "react";

import { isGatewayStatus, REQUEST_TIMEOUT_MS } from "./voiceErrors";
import { voiceLog } from "./voiceLog";

/**
 * Whether this page's plain requests reach lalala (on lalala.talk, whether the harness answers). A phone switching networks can keep new sockets
 * working while every fetch queues on a dead connection (9 Nov, 4.5 min): a failed health check or
 * send marks the link down, and a probe every few seconds brings it back up.
 */
const PROBE = "/__lalala/config";
const PROBE_EVERY_MS = 2_000;

let down = false;
let downSince = 0;
let timer = 0;
const listeners = new Set<() => void>();
const upListeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export const linkIsDown = () => down;

function markLinkUp(): void {
  if (!down) return;
  down = false;
  window.clearTimeout(timer);
  voiceLog("system", "link.up", { downMs: Date.now() - downSince });
  notify();
  for (const listener of upListeners) listener();
}

export function markLinkDown(why: string): void {
  if (down) return;
  down = true;
  downSince = Date.now();
  voiceLog("system", "link.down", { why });
  notify();
  schedule();
}

/** True when lalala answers (anything but its front door's 502/503/504) within the timeout. */
async function probe(): Promise<boolean> {
  try {
    const harness = globalThis.__lalalaAdapters?.harness;
    if (harness) {
      await Promise.race([
        harness.config(),
        new Promise((_, reject) => window.setTimeout(reject, REQUEST_TIMEOUT_MS)),
      ]);
      return true;
    }
    const response = await fetch(PROBE, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return !isGatewayStatus(response.status);
  } catch {
    return false;
  }
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    if (!down) return;
    if (await probe()) markLinkUp();
    else schedule();
  }, PROBE_EVERY_MS);
}

/** Asks lalala now and marks the link by its answer; true when it is up. */
export async function checkLink(why: string): Promise<boolean> {
  const up = await probe();
  if (up) markLinkUp();
  else markLinkDown(why);
  return up;
}

/** Calls `listener` each time the link comes back. Returns the unsubscribe. */
export function onLinkUp(listener: () => void): () => void {
  upListeners.add(listener);
  return () => upListeners.delete(listener);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useLinkDown(): boolean {
  return useSyncExternalStore(subscribe, linkIsDown);
}
