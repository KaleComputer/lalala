import { useSyncExternalStore } from "react";

// An update is waiting for the call to end (updateChip.ts); the bar shows a chip to apply it now.
let ready = false;
const listeners = new Set<() => void>();

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
