/**
 * What differs between the lalala app and lalala.talk, picked once at startup: everything else
 * (canvas, cards, bar, settings, the call and its in-browser speech) is the same code. The app installs the server adapters
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

/** The coding harness (T3 Code) the voice works through. */
export type HarnessAdapter = {
  /** What the app's `/__lalala/config` answers: the brain's workspace, or null while not set up. */
  config(): Promise<{ readonly workspaceRoot: string; readonly model: string | null } | null>;
  /** The brain thread's events (vite/t3bridge.mjs's `hello`, `row`, `active`). Returns the unsubscribe. */
  events(listener: (event: unknown) => void): () => void;
  /** One orchestration command for the harness. */
  send(command: unknown): Promise<unknown>;
  /**
   * A text file in the brain thread's project, null when it is not there. Only lalala.talk has
   * it: its prebuilt page can't load card code, so the brain writes cards there as files
   * (`[card …]` in its replies, src/voice/brainCards.ts) instead of under src/voice/extras/.
   */
  readFile?(relativePath: string): Promise<string | null>;
};

export type Adapters = {
  readonly storage: StorageAdapter;
  /** The app's way to the brain's card files (its server reads the cards folder); the site's is the harness's. */
  readonly readFile?: (relativePath: string) => Promise<string | null>;
  readonly harness?: HarnessAdapter;
};

declare global {
  var __lalalaAdapters: Adapters | undefined;
}

/** How this host reads a card file the brain wrote (`cards/<id>.html`), if it can. */
export const brainFileReader = () =>
  globalThis.__lalalaAdapters?.harness?.readFile ?? globalThis.__lalalaAdapters?.readFile;

export function installAdapters(adapters: Adapters) {
  globalThis.__lalalaAdapters = adapters;
}
