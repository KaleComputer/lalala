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
const REPLY_VOICE_KEY = "lalala:reply-voice";
const STT_MODEL_KEY = "lalala:stt-model";
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

/** A phone or tablet by its user agent: speech picks its models by device, not by window width. */
export const isPhoneDevice = () =>
  typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
const phone = isPhoneDevice;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // No storage: the default.
  }
  document.dispatchEvent(new Event(EVENT));
};

/**
 * The reply voice a device starts on: Kale's own Matcha voice on phones, where Kokoro on the CPU
 * took about twice a sentence's length to render it (Tim's iPhone, 14 Nov); Kokoro elsewhere.
 */
export const defaultReplyVoice = (): string => (phone() ? "matcha" : "kokoro");

/**
 * Who speaks the replies on this device: "auto" (nothing stored: defaultReplyVoice), "kokoro" (its
 * build picked by the device), "kokoro-gpu", "kokoro-cpu", Kale's "matcha", "computer" (Kokoro on
 * the computer running T3, opt-in), or a voice the user's cards registered (replyVoices.ts) by its id.
 */
export const replyVoicePick = (): string => {
  const stored = read(REPLY_VOICE_KEY) ?? "auto";
  // Before 15 Nov "kokoro" let the device pick Kokoro's build, as automatic does on a desktop.
  if (stored === "kokoro") return phone() ? "kokoro-cpu" : "auto";
  return stored;
};
export const setReplyVoice = (voice: string) => write(REPLY_VOICE_KEY, voice === "auto" ? null : voice);
/** The voice that speaks now, with "auto" resolved for this device. */
export const replyVoice = (): string => {
  const pick = replyVoicePick();
  return pick === "auto" ? defaultReplyVoice() : pick;
};

/**
 * What hears on this device: a Parakeet in this browser, "auto" picking by device (phones the 110M, a
 * desktop with WebGPU 16-bit floats the 0.6B on the GPU, else the 0.6B on the CPU; the 0.6B int8 plus
 * Kokoro ended Tim's iPhone tab, 14 Nov), or "computer" (Parakeet on the computer running T3, opt-in).
 */
export type SttModel = "auto" | "0.6b-gpu" | "0.6b-cpu" | "110m" | "computer";
const STT_MODELS: ReadonlyArray<SttModel> = ["auto", "0.6b-gpu", "0.6b-cpu", "110m", "computer"];
export function sttModel(): SttModel {
  const stored = read(STT_MODEL_KEY);
  // Before 15 Nov "0.6b" was the GPU build on desktops and the CPU one on phones.
  if (stored === "0.6b") return phone() ? "0.6b-cpu" : "0.6b-gpu";
  return STT_MODELS.find((model) => model === stored) ?? "auto";
}
export const setSttModel = (model: SttModel) => write(STT_MODEL_KEY, model === "auto" ? null : model);

/** Whether opening lalala starts the call on this device ("lalala:auto-start" is "on"); off by default. */
const AUTO_START_KEY = "lalala:auto-start";
export const autoStartCall = () => read(AUTO_START_KEY) === "on";
export const setAutoStartCall = (on: boolean) => write(AUTO_START_KEY, on ? "on" : null);

/**
 * Whether lalala retries on its own when loading fails (the page's boot loader, a speech model):
 * "lalala:auto-retry" is "off" or a number of seconds; nothing stored is on, every 5 s.
 */
const AUTO_RETRY_KEY = "lalala:auto-retry";
export const DEFAULT_AUTO_RETRY_SECONDS = 5;
export const AUTO_RETRY_CHOICES = [5, 15, 60] as const;
/** The interval in seconds, the nearest of the choices (a hand-set value too), or null when off. */
export function autoRetrySeconds(): number | null {
  const stored = read(AUTO_RETRY_KEY);
  if (stored === "off") return null;
  const seconds = Number(stored);
  if (stored === null || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_AUTO_RETRY_SECONDS;
  return AUTO_RETRY_CHOICES.reduce((best, every) =>
    Math.abs(every - seconds) < Math.abs(best - seconds) ? every : best,
  );
}
export const setAutoRetrySeconds = (seconds: number | null) =>
  write(
    AUTO_RETRY_KEY,
    seconds === null ? "off" : seconds === DEFAULT_AUTO_RETRY_SECONDS ? null : String(seconds),
  );

export const subscribeSettings = (listener: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== SYNCED_KEY &&
      event.key !== MIC_KEY &&
      event.key !== REPLY_VOICE_KEY &&
      event.key !== STT_MODEL_KEY &&
      event.key !== AUTO_RETRY_KEY &&
      event.key !== AUTO_START_KEY
    )
      return;
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
export const useReplyVoicePick = () =>
  useSyncExternalStore(subscribeSettings, replyVoicePick, () => "auto");
export const useSttModel = () =>
  useSyncExternalStore(subscribeSettings, sttModel, () => "auto" as SttModel);
export const useAutoStartCall = () =>
  useSyncExternalStore(subscribeSettings, autoStartCall, () => false);
export const useAutoRetrySeconds = () =>
  useSyncExternalStore(subscribeSettings, autoRetrySeconds, () => DEFAULT_AUTO_RETRY_SECONDS);

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
