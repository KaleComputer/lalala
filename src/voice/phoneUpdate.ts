import { useSyncExternalStore } from "react";

// An update is waiting for the call to end (callGuard.ts); the bar shows a chip to apply it now.
let ready = false;
const listeners = new Set<() => void>();

// Synchronous in-memory flag set by VoiceHost as soon as a call starts (connecting through hangup),
// so callGuard never misses a call during a DOM-commit or state-transition gap.
let callLive = false;

export function setCallLive(live: boolean): void {
  callLive = live;
}

export function isCallLive(): boolean {
  return callLive;
}

export function markUpdateReady(): void {
  if (ready) return;
  ready = true;
  for (const listener of listeners) listener();
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ready,
    () => false,
  );
}
