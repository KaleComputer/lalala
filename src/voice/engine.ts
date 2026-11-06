/**
 * Which speech engine t3voice uses: always Parakeet + Kokoro on the local speech service
 * (`scripts/speech.sh`). Kept as a seam for other engines.
 */
import { useSyncExternalStore } from "react";

export type SpeechEngine = "local";

const KEY = "t3voice:engine";
const listeners = new Set<() => void>();

export function speechEngine(): SpeechEngine {
  return "local";
}

/** Calls `listener` whenever the choice changes, in this tab or another. Returns the unsubscribe. */
export function subscribeSpeechEngine(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSpeechEngine(): SpeechEngine {
  return useSyncExternalStore(subscribeSpeechEngine, speechEngine);
}
