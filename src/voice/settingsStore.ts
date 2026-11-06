import { useSyncExternalStore } from "react";

/**
 * The voice's own settings. `synced` is one value for every device (the dev server keeps it,
 * `/__t3voice/t3/settings`, newest write wins; without that route it stays on this device); the mic
 * is per device. The brain's own model lives on its T3 thread, not here.
 */
export type OptionValue = string | boolean;

/** What `delegate_task` gets for new threads; a null model is T3's default model. */
export type Delegates = {
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly options: Readonly<Record<string, OptionValue>>;
};

export type SyncedSettings = {
  readonly delegates: Delegates;
  /** A sound in extras/topicSounds-<name>.mp3, or "none". */
  readonly topicSound: string;
  readonly at: number;
};

// High reasoning, fast mode off: what delegates ran with before these settings existed.
const DEFAULT_DELEGATES: Delegates = {
  instanceId: null,
  model: null,
  options: { effort: "high", fastMode: false },
};
export const DEFAULT_TOPIC_SOUND = "soft-ping";
const DEFAULTS: SyncedSettings = {
  delegates: DEFAULT_DELEGATES,
  topicSound: DEFAULT_TOPIC_SOUND,
  at: 0,
};

const SYNCED_KEY = "t3voice:settings";
const MIC_KEY = "t3voice:mic";
const EVENT = "t3voice:settings";
const ROUTE = "/__t3voice/t3/settings";

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
  void fetch(ROUTE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((saved: unknown) => {
      const parsed = parseSynced(saved);
      if (parsed && parsed.at > current().at) adopt(parsed);
    })
    .catch(() => undefined);
}

/** Takes the other devices' newer settings, if the dev server keeps them. */
export function pullSynced(): void {
  void fetch(ROUTE, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
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

/** The chosen topic sound's file, null for none. The page build lists every extras sound (extrasImages.ts). */
export function topicSoundUrl(name = current().topicSound): string | null {
  if (name === "none") return null;
  return (
    globalThis.__t3voiceImages?.[`./extras/topicSounds-${name}.mp3`] ??
    globalThis.__t3voiceImages?.[`./extras/topicSounds-${DEFAULT_TOPIC_SOUND}.mp3`] ??
    null
  );
}

export const topicSoundNames = () =>
  Object.keys(globalThis.__t3voiceImages ?? {})
    .map((path) => /^\.\/extras\/topicSounds-(.+)\.mp3$/.exec(path)?.[1])
    .filter((name): name is string => name !== undefined)
    .toSorted();
