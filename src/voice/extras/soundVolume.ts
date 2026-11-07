import { useSyncExternalStore } from "react";

// One volume, per device, for every sound but the voice and the mic: the topic sound, the call's
// chimes, card samples and games. Everything that plays follows it live.
const KEY = "lalala:sound-volume";
const EVENT = "lalala:sound-volume";

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

let level: number | null = null;
function read(): number {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? 1 : clamp(Number(stored));
  } catch {
    return 1;
  }
}

/** The slider, 0 to 1. */
const soundVolume = () => (level ??= read());

/** The slider squared, so its steps sound even. */
export const soundGain = () => soundVolume() ** 2;

export function setSoundVolume(value: number) {
  level = clamp(value);
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // No storage: this tab keeps it in memory.
  }
  document.dispatchEvent(new Event(EVENT));
}

function subscribeSoundVolume(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    level = null;
    listener();
  };
  document.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const useSoundVolume = () =>
  useSyncExternalStore(subscribeSoundVolume, soundVolume, () => 1);

const outputs = new WeakMap<AudioContext, GainNode>();

/** The context's sound output at the volume: connect sounds here instead of `ctx.destination`. */
export function soundOutput(ctx: AudioContext): GainNode {
  const known = outputs.get(ctx);
  if (known) return known;
  const node = ctx.createGain();
  node.gain.value = soundGain();
  node.connect(ctx.destination);
  outputs.set(ctx, node);
  const stop = subscribeSoundVolume(() =>
    node.gain.setTargetAtTime(soundGain(), ctx.currentTime, 0.02),
  );
  const onState = () => {
    if (ctx.state !== "closed") return;
    stop();
    ctx.removeEventListener("statechange", onState);
  };
  ctx.addEventListener("statechange", onState);
  return node;
}

let volumeSettable: boolean | null = null;
let shared: AudioContext | null = null;
const followed = new WeakSet<HTMLMediaElement>();

/** Keeps an audio element at the volume while it plays: `withSoundVolume(new Audio(url))`. */
export function withSoundVolume<T extends HTMLMediaElement>(audio: T): T {
  if (followed.has(audio)) return audio;
  followed.add(audio);
  if (volumeSettable === null) {
    const probe = new Audio();
    probe.volume = 0.5;
    volumeSettable = probe.volume === 0.5;
  }
  if (!volumeSettable) {
    // iOS fixes an element's volume at 1, so below full it plays through a gain instead.
    if (soundVolume() < 1) {
      shared ??= new AudioContext();
      const context = shared;
      void context.resume();
      audio.addEventListener("play", () => void context.resume());
      context.createMediaElementSource(audio).connect(soundOutput(context));
    }
    return audio;
  }
  const follow = () => {
    audio.volume = soundGain();
  };
  follow();
  let stop: (() => void) | null = null;
  audio.addEventListener("play", () => {
    follow();
    stop ??= subscribeSoundVolume(follow);
  });
  audio.addEventListener("pause", () => {
    stop?.();
    stop = null;
  });
  return audio;
}
