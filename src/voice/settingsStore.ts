import { useSyncExternalStore } from "react";

import { REQUEST_TIMEOUT_MS } from "./voiceErrors";

/**
 * The voice's own settings. `synced` is one value for every device (the storage adapter keeps it,
 * newest write wins; without a shared store it stays on this device); the mic is per device. The brain's own model lives on its T3 thread, not here.
 */
export type OptionValue = string | boolean;

/** What `delegate_task` gets for new threads; a null model is T3's default model. */
export type Delegates = {
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly modelName: string | null;
  readonly options: Readonly<Record<string, OptionValue>>;
};

export type SyncedSettings = {
  readonly delegates: Delegates;
  /** A sound in extras/topicSounds-<name>.mp3, the built-in "chime", or "none". */
  readonly topicSound: string;
  readonly at: number;
};

// The brain's model with its own defaults: options are per provider (Claude's `effort`, Codex's
// `reasoningEffort`), and T3 refuses a delegate whose options its model doesn't have.
const DEFAULT_DELEGATES: Delegates = { instanceId: null, model: null, modelName: null, options: {} };
export const DEFAULT_TOPIC_SOUND = "soft-ping";
/** The topic sound the player renders itself instead of loading a file. */
export const BUILT_IN_TOPIC_SOUND = "chime";
const DEFAULTS: SyncedSettings = {
  delegates: DEFAULT_DELEGATES,
  topicSound: DEFAULT_TOPIC_SOUND,
  at: 0,
};

const SYNCED_KEY = "lalala:settings";
const MIC_KEY = "lalala:mic";
const EVENT = "lalala:settings";
const storage = () => {
  const adapter = globalThis.__lalalaAdapters?.storage;
  return adapter?.shared ? adapter : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSynced(value: unknown): SyncedSettings | null {
  if (!isRecord(value)) return null;
  const delegates = isRecord(value.delegates) ? value.delegates : {};
  const options = isRecord(delegates.options)
    ? Object.fromEntries(
        Object.entries(delegates.options).filter(
          (entry): entry is [string, OptionValue] =>
            typeof entry[1] === "string" || typeof entry[1] === "boolean",
        ),
      )
    : DEFAULT_DELEGATES.options;
  return {
    delegates: {
      instanceId: typeof delegates.instanceId === "string" ? delegates.instanceId : null,
      model: typeof delegates.model === "string" ? delegates.model : null,
      modelName: typeof delegates.modelName === "string" ? delegates.modelName : null,
      options,
    },
    topicSound: typeof value.topicSound === "string" ? value.topicSound : DEFAULT_TOPIC_SOUND,
    at: typeof value.at === "number" ? value.at : 0,
  };
}

function readLocal(): SyncedSettings {
  try {
    return parseSynced(JSON.parse(localStorage.getItem(SYNCED_KEY) ?? "null")) ?? DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let synced: SyncedSettings | null = null;
const current = () => (synced ??= readLocal());

function adopt(next: SyncedSettings) {
  synced = next;
  try {
    localStorage.setItem(SYNCED_KEY, JSON.stringify(next));
  } catch {
    // No storage: this tab keeps it in memory.
  }
  document.dispatchEvent(new Event(EVENT));
}

export const syncedSettings = (): SyncedSettings => current();

export function updateSynced(patch: Partial<Omit<SyncedSettings, "at">>) {
  const next = { ...current(), ...patch, at: Math.max(Date.now(), current().at + 1) };
  adopt(next);
  void storage()
    ?.write("settings", next)
    .then((saved: unknown) => {
      const parsed = parseSynced(saved);
      if (parsed && parsed.at > current().at) adopt(parsed);
    })
    .catch(() => undefined);
}

/** Takes the other devices' newer settings, if the dev server keeps them. */
export function pullSynced(): void {
  void storage()
    ?.read("settings")
    .then((saved: unknown) => {
      const parsed = parseSynced(saved);
      if (parsed && parsed.at > current().at) adopt(parsed);
    })
    .catch(() => undefined);
}

export function micDeviceId(): string | null {
  try {
    return localStorage.getItem(MIC_KEY) || null;
  } catch {
    return null;
  }
}

export function setMicDeviceId(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(MIC_KEY);
    else localStorage.setItem(MIC_KEY, id);
  } catch {
    // No storage: the default mic.
  }
  document.dispatchEvent(new Event(EVENT));
}

export const subscribeSettings = (listener: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SYNCED_KEY && event.key !== MIC_KEY) return;
    synced = null;
    listener();
  };
  document.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

export const useSyncedSettings = () =>
  useSyncExternalStore(subscribeSettings, syncedSettings, () => DEFAULTS);
export const useMicDeviceId = () =>
  useSyncExternalStore(subscribeSettings, micDeviceId, () => null);

/** For the brain's context tag: `default effort=high fastMode=false`. */
export function delegatesTag(delegates = current().delegates): string {
  const model =
    delegates.model === null
      ? "default"
      : delegates.instanceId === null
        ? delegates.model
        : `${delegates.instanceId}/${delegates.model}`;
  const options = Object.entries(delegates.options).map(([id, value]) => `${id}=${value}`);
  return [model, ...options].join(" ");
}

declare global {
  /** The extras' pictures and sounds as URLs (extrasImages.ts in the app, the site's own list). */
  var __lalalaImages: Readonly<Record<string, string>> | undefined;
}

/** The chosen topic sound's file, null for none or the built-in chime. The page build lists every extras sound (extrasImages.ts). */
export function topicSoundUrl(name = current().topicSound): string | null {
  if (name === "none" || name === BUILT_IN_TOPIC_SOUND) return null;
  return (
    globalThis.__lalalaImages?.[`./extras/topicSounds-${name}.mp3`] ??
    globalThis.__lalalaImages?.[`./extras/topicSounds-${DEFAULT_TOPIC_SOUND}.mp3`] ??
    null
  );
}

export const topicSoundNames = () =>
  Object.keys(globalThis.__lalalaImages ?? {})
    .map((path) => /^\.\/extras\/topicSounds-(.+)\.mp3$/.exec(path)?.[1])
    .filter((name): name is string => name !== undefined)
    .toSorted();
