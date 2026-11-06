/**
 * What differs between the lalala app and lalala.talk, picked once at startup: everything else
 * (canvas, cards, bar, settings, the call) is the same code. The app installs the server adapters
 * (main.tsx), the site the browser ones (site/app/canvas/adapters.ts), before the canvas loads.
 * On a global, because the canvas's extras bundle may import only React and its own folder.
 */

/** A document every device of this user shares: the canvas layout, the voice settings. */
export type SharedDoc = "canvas" | "settings";

/**
 * Where shared documents live besides this browser's localStorage (which the stores always keep).
 * Both calls answer what is stored now (newest write wins), or null when nothing is shared.
 */
export type StorageAdapter = {
  /** False: this browser is the only copy, so the stores never poll. */
  readonly shared: boolean;
  read(doc: SharedDoc): Promise<unknown>;
  write(doc: SharedDoc, body: unknown, options?: { readonly leaving?: boolean }): Promise<unknown>;
};

/**
 * Speech in and out. The app's runs on the local speech service (Parakeet and Kokoro on MLX), the
 * site's in the browser (Parakeet and Kokoro on ONNX, WebGPU or WASM).
 */
export type SpeechAdapter = {
  /** One listening session: 16 kHz PCM goes in while the user talks, each commit is an utterance. */
  listen(): Promise<{
    send(pcm: Int16Array): void;
    commit(): Promise<string>;
    close(): void;
  }>;
  /** One sentence as 24 kHz PCM, streamed in pieces as it renders. */
  speak(text: string, signal: AbortSignal): AsyncIterable<Float32Array>;
  /** Model downloads and warm-up, for the bar's readout; null once ready or with nothing to load. */
  progress?(): string | null;
};

/** The coding harness (T3 Code) the voice works through. */
export type HarnessAdapter = {
  /** The brain thread's events (vite/t3bridge.mjs's `hello`, `row`, `active`). Returns the unsubscribe. */
  events(listener: (event: unknown) => void): () => void;
  /** One orchestration command for the harness. */
  send(command: unknown): Promise<unknown>;
};

export type Adapters = {
  readonly storage: StorageAdapter;
  readonly speech?: SpeechAdapter;
  readonly harness?: HarnessAdapter;
};

declare global {
  var __lalalaAdapters: Adapters | undefined;
}

export function installAdapters(adapters: Adapters) {
  globalThis.__lalalaAdapters = adapters;
}
