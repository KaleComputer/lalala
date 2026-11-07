// lalala.talk's side of src/voice/adapters: no server, so layout and settings stay in this browser,
// speech runs in it, and the call reaches the visitor's own T3 Code from the tab (once paired).
// Imported before the canvas, whose store and bridge read the adapters when they load.
import { useSyncExternalStore } from "react";

import { type HarnessAdapter, installAdapters } from "../../../src/voice/adapters";
import { browserBrain, browserHarness } from "../../../src/voice/adapters/harness/browser";
import { type Session, forgetSession, saveBrainThread } from "../../../src/voice/adapters/harness/t3";
import { browserSpeech } from "../../../src/voice/adapters/speech/browser";
import { browserStorage } from "../../../src/voice/adapters/storage/browser";

type Listener = (event: unknown) => void;

// The bridge subscribes once when it loads, so pairing (or another thread) later swaps what this
// harness follows underneath its listeners instead of installing a new one.
let current: HarnessAdapter | null = browserBrain() ? browserHarness() : null;
let version = 0;
// The brain version whose call starts as soon as it mounts (see followBrainThread).
let startsWith = -1;
let callOnConnect = false;
const subscriptions = new Map<Listener, () => void>();
const brainListeners = new Set<() => void>();

const UNPAIRED = { type: "hello", connected: false, error: null, workspaceRoot: null, shell: null, rows: [] };

function follow(next: HarnessAdapter | null, startCall = false) {
  current = next;
  version += 1;
  startsWith = startCall ? version + 1 : -1;
  for (const [listener, stop] of subscriptions) {
    stop();
    subscriptions.set(listener, next ? next.events(listener) : () => {});
    if (!next) listener(UNPAIRED);
  }
  for (const listener of brainListeners) listener();
}

const harness: HarnessAdapter = {
  config: () => current?.config() ?? Promise.resolve(null),
  events(listener) {
    subscriptions.set(listener, current ? current.events(listener) : () => {});
    return () => {
      subscriptions.get(listener)?.();
      subscriptions.delete(listener);
    };
  },
  send(command) {
    if (!current) return Promise.reject(new Error("Not paired with T3 Code yet"));
    return current.send(command);
  },
};

installAdapters({ storage: browserStorage, speech: browserSpeech(), harness });

const callLive = () =>
  (document.querySelector<HTMLElement>("[data-lalala-presence]")?.dataset.voiceState ?? "off") !== "off";

/** The bar's call button was tapped before pairing: the call starts once Connection is set up. */
export const wantCallOnConnect = (want: boolean) => {
  callOnConnect = want;
};

/**
 * The call talks to this thread on the paired T3 from now on. Its call starts right away when the
 * call button led here, or keeps going when one was live on the previous thread. Says whether a call runs.
 */
export function followBrainThread(session: Session, threadId: string) {
  const startCall = callOnConnect || callLive();
  callOnConnect = false;
  saveBrainThread(session.origin, threadId);
  follow(browserHarness(), startCall);
  return startCall;
}

/** Whether this brain version's call starts as soon as it mounts. */
export const callStartsWith = (brainVersion: number) => brainVersion === startsWith;

/** Forgets the pairing: the bar goes back to opening the Connection section. */
export function disconnectBrain() {
  forgetSession();
  follow(null);
}

/** Which brain the call follows: changes on every pairing or thread pick (0 while unpaired). */
export function useBrainVersion() {
  return useSyncExternalStore(
    (listener) => {
      brainListeners.add(listener);
      return () => brainListeners.delete(listener);
    },
    () => (current ? version + 1 : 0),
    () => 0,
  );
}

// The settings' topic sounds, where the app's build lists them (src/voice/extrasImages.ts).
globalThis.__lalalaImages = Object.fromEntries(
  (process.env.LALALA_TOPIC_SOUNDS ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => [`./extras/topicSounds-${name}.mp3`, `/sounds/${name}.mp3`]),
);
