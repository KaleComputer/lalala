import { useSyncExternalStore } from "react";

// t3voice runs on Vite's dev server.
export const voiceEnabled = import.meta.env.DEV || import.meta.env.VITE_T3VOICE === "1";

// Whether the voice bar is shown. It stays across views until the user hides it; hidden, no mic runs.
let open = false;
const listeners = new Set<() => void>();

export function setVoiceOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function useVoiceOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}
