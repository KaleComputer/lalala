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
  /** The voice picked inside each model that holds more than one, by model folder (SMALL_VOICES). */
  readonly modelVoices: Readonly<Record<string, string>>;
  /** Labs: features still settling in, each off until the user turns it on (VoiceSettings' Labs). */
  readonly labs: Labs;
  readonly at: number;
};

export type Labs = {
  /** Results that came in while the user wasn't in a call, kept until heard (src/voice/inbox). */
  readonly awayInbox: boolean;
  /** One digest after two hours away, through LALALA_DIGEST_COMMAND (the app only). */
  readonly awayDigest: boolean;
};
const DEFAULT_LABS: Labs = { awayInbox: false, awayDigest: false };

// The brain's model with its own defaults: options are per provider (Claude's `effort`, Codex's
// `reasoningEffort`), and T3 refuses a delegate whose options its model doesn't have.
const DEFAULT_DELEGATES: Delegates = { instanceId: null, model: null, modelName: null, options: {} };
export const DEFAULT_TOPIC_SOUND = "soft-ping";
/** The topic sound the player renders itself instead of loading a file. */
export const BUILT_IN_TOPIC_SOUND = "chime";
const DEFAULTS: SyncedSettings = {
  delegates: DEFAULT_DELEGATES,
  topicSound: DEFAULT_TOPIC_SOUND,
  modelVoices: {},
  labs: DEFAULT_LABS,
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
    modelVoices: isRecord(value.modelVoices)
      ? Object.fromEntries(
          Object.entries(value.modelVoices).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {},
    labs: {
      awayInbox: isRecord(value.labs) && value.labs.awayInbox === true,
      awayDigest: isRecord(value.labs) && value.labs.awayDigest === true,
    },
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

export const setLab = (name: keyof Labs, on: boolean) =>
  updateSynced({ labs: { ...current().labs, [name]: on } });

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

/** Kale's warm voice, Kokoro, by its id in the settings. */
export const WARM_VOICE = "kale-kokoro";
/** The 8-voice kale-tts-1-nano (~10 MB, one graph, clean recipe), with the storyteller (v7). */
export const NANO_VOICE = "kale-tts-1-nano";
/** kale-tts-1-tiny (61 MB, the same 8 voices, clean recipe, no Hazel). */
export const TINY_VOICE = "kale-tts-1-tiny";
/** The 10-voice kale-tts-1-nano and -tiny (release10, 16 Nov), with the voices' public names; nano is Automatic. */
export const NANO10_VOICE = "kale-tts-1-nano-10";
export const TINY10_VOICE = "kale-tts-1-tiny-10";
/** k10c (61 MB, Hazel's voice), which was called kale-tts-1-tiny until the clean build took the name. */
export const K10C_VOICE = "k10c";
/** The cheerful storyteller (voice 8 on the k10c recipe, 61 MB, 190 wpm): Tim's pick, 15 Nov. */
export const STORY_VOICE = "kale-storyteller";
/** The two-voice kale-tts-1-tiny preview (storyteller and M3; Hazel's model underneath for now). */
export const PREVIEW_VOICE = "kale-tts-1-tiny-preview";
export type ModelVoice = { readonly id: string; readonly name: string };
/** kale-tts-1-tiny's and -nano's voices, in the picker's order, named as in the release's voices.json. */
const EIGHT_VOICES: ReadonlyArray<ModelVoice> = [
  { id: "v7", name: "Storyteller (American woman, 30s, cheerful)" },
  { id: "m3", name: "Host (American man, 20s, bright)" },
  { id: "d03", name: "British woman (30s, crisp)" },
  { id: "d13", name: "British man (50s, crisp)" },
  { id: "f03", name: "Young woman (American, 20s, light)" },
  { id: "f06", name: "Woman (40s, deep and confident)" },
  { id: "f13", name: "Young man (Latino American, 20s, upbeat)" },
  { id: "e21", name: "Storyteller man (Latino American, 50s, calm)" },
];
/** The 10-voice build's voices, in the release's order and names (voices10.json, Tim's ok, 16 Nov). */
const TEN_VOICES: ReadonlyArray<ModelVoice> = [
  { id: "s057b", name: "Kenzie · esports hype woman" },
  { id: "f06", name: "Simone · deep and confident woman" },
  { id: "d03", name: "Amy · British woman, crisp news-style" },
  { id: "w165", name: "Frankie · hard-boiled detective's partner" },
  { id: "w602", name: "Darlene · rough low-voiced old trucker woman" },
  { id: "m3", name: "Owen · bright young host" },
  { id: "t071", name: "Toby · mischievous prankster" },
  { id: "d13", name: "Jack · British man, crisp news-style" },
  { id: "x328", name: "Earl · African American jazz granddad" },
  { id: "h013f", name: "Magnus · deep dramatic trailer narrator" },
];
/**
 * Kale's small voices: their model folder (public/models, for kaleVoice.worker) and the voices it
 * holds (voices/<id>.bin, samples/<id>.mp3 for Settings' play buttons when there are several).
 */
export const SMALL_VOICES: Readonly<
  Record<
    string,
    {
      readonly model: string;
      readonly voices: ReadonlyArray<ModelVoice>;
      readonly speed?: number;
      /** The model's own download: its graph and one voice (the bar's total, Settings' cost). */
      readonly bytes: number;
    }
  >
> = {
  // Its package's config.json: its duration head reads ~10 % short, so 0.92.
  [WARM_VOICE]: { model: "kale-kokoro", voices: [{ id: "warm", name: "Warm" }], speed: 0.92, bytes: 68_142_913 },
  [STORY_VOICE]: {
    model: "kale-storyteller",
    voices: [{ id: "storyteller", name: "Storyteller" }],
    bytes: 61_507_783,
  },
  [NANO_VOICE]: { model: "kale-tts-1-nano", voices: EIGHT_VOICES, bytes: 10_676_685 },
  [TINY_VOICE]: { model: "kale-tts-1-tiny", voices: EIGHT_VOICES, bytes: 61_524_303 },
  [NANO10_VOICE]: { model: "kale-tts-1-nano-10", voices: TEN_VOICES, bytes: 10_811_514 },
  // The Ettin text side: its tokenizer (2.1 MB) loads with it.
  [TINY10_VOICE]: { model: "kale-tts-1-tiny-10", voices: TEN_VOICES, bytes: 78_050_494 },
  [K10C_VOICE]: { model: "k10c", voices: [{ id: "hazel", name: "Hazel" }], bytes: 61_507_783 },
  [PREVIEW_VOICE]: {
    model: "kale-tts-1-tiny-preview",
    voices: [
      { id: "storyteller", name: "Storyteller" },
      { id: "m3", name: "M3" },
    ],
    bytes: 61_508_590,
  },
};
/**
 * The voice a small model speaks with: the one picked for that model (synced; Settings or the brain),
 * else its first, the default (Tim, 16 Nov). Picks are kept per model, so a switch never carries a
 * voice into a model that doesn't have it.
 */
export const modelVoice = (voice: string): string | null => {
  const small = SMALL_VOICES[voice];
  if (!small) return null;
  const picked = current().modelVoices[small.model];
  return small.voices.find((entry) => entry.id === picked)?.id ?? small.voices[0]!.id;
};
export const setModelVoice = (model: string, voice: string) =>
  updateSynced({ modelVoices: { ...current().modelVoices, [model]: voice } });
/** Kale's own voices, all in kaleVoice.worker, one model at a time. */
export const isKaleVoice = (voice: string) => voice in SMALL_VOICES;


/**
 * The reply voice every device starts on: the 10-voice kale-tts-1-nano (Tim, 16 Nov: "I want to
 * have the new model"); the 8-voice builds, the storyteller, k10c and the warm Kokoro are picks.
 */
export const defaultReplyVoice = (): string => NANO10_VOICE;

/**
 * Who speaks the replies on this device: "auto" (nothing stored: defaultReplyVoice), Kale's
 * "kale-storyteller", "kale-kokoro" or "kale-tts-1-tiny", "kokoro-gpu", "kokoro-cpu" (Kokoro 82M), "computer" (Kokoro on the computer running
 * T3, opt-in), or a voice the user's cards registered (replyVoices.ts) by its id.
 */
export const replyVoicePick = (): string => {
  const stored = read(REPLY_VOICE_KEY) ?? "auto";
  // Before 15 Nov "kokoro" let the device pick Kokoro's build, as Automatic did on a desktop then;
  // "matcha" was Matcha, now gone (Tim, 15 Nov): both are Automatic's voice now. "llama-kokoro" was
  // this voice's id on 15 Nov.
  if (stored === "kokoro") return phone() ? "kokoro-cpu" : "auto";
  if (stored === "matcha") return "auto";
  if (stored === "llama-kokoro") return WARM_VOICE;
  return stored;
};
export const setReplyVoice = (voice: string) => {
  write(REPLY_VOICE_KEY, voice === "auto" ? null : voice);
};
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
