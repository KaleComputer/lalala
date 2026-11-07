import { type CallWaveLevels, type CallWaveSpectrum, createCallWave } from "./presence/callwave";
import { createFrame, type PresenceFrame } from "./presence/frame";
import { BAR_HTML } from "./presence/markup";
import { showSweep, startSweepClock } from "./voiceSounds";

// Framework-free so lalala.talk (site/) mounts the very same bar as the app's VoiceBar.

export type VoiceBarState =
  | "off"
  | "connecting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type VoiceBarAnalysis = {
  readonly levels: CallWaveLevels;
  readonly spectrum: CallWaveSpectrum | null;
};

// Our states in Presence's terms (frame.js `state({ line, voice })`): the user talking is listening.
export const PRESENCE_STATE: Record<VoiceBarState, { line: string; voice: string }> = {
  off: { line: "idle", voice: "idle" },
  connecting: { line: "connecting", voice: "connecting" },
  listening: { line: "listening", voice: "listening" },
  hearing: { line: "listening", voice: "listening" },
  transcribing: { line: "thinking", voice: "thinking" },
  thinking: { line: "thinking", voice: "thinking" },
  speaking: { line: "speaking", voice: "speaking" },
  error: { line: "error", voice: "error" },
};

// Nothing moving out of a call: the wave polls instead of drawing every frame (Presence's REST_MS).
const REST_MS = 100;
// The user's voice fills the listening wash (voiceBar.css --lalala-voice): their frame level in dB from the
// room's quiet to a close voice, quick to rise, slow to fall, written only when it moves.
const VOICE_QUIET_DB = -50;
const VOICE_FULL_DB = -24;
const VOICE_RISE = 14;
const VOICE_FALL = 2.5;
const VOICE_STEP = 0.01;

/**
 * The tabs over the map: Presence's state tab holds only the timer (its glyph stays inside, hidden, so
 * frame.js still finds it), and apart from them the lead tab at the bar's left end, which takes UPDATE
 * when an update waits for the call to end. Moved before createFrame; frame.js finds each part by its selector.
 */
function makeStatusTab(frameEl: HTMLElement) {
  const tab = frameEl.querySelector<HTMLElement>("[data-tab]");
  const timer = frameEl.querySelector<HTMLElement>("[data-timer]");
  if (tab === null || timer === null) return;
  tab.append(timer);
  const lead = document.createElement("span");
  lead.className = "lalala-lead";
  // Left to right: the canvases (a layers tab), the input (keyboard and paperclip in one tab, VoiceInput),
  // the mic, the settings gear, then the time. Out of a call all but the gear are empty, inert slots.
  const canvas = document.createElement("span");
  canvas.className = "lalala-canvas-slot";
  const input = document.createElement("span");
  input.className = "lalala-input-slot";
  const mic = document.createElement("span");
  mic.className = "lalala-mic-slot";
  const settings = document.createElement("span");
  settings.className = "lalala-settings-slot";
  const row = document.createElement("div");
  row.className = "lalala-tabs";
  row.append(canvas, input, mic, settings, tab);
  // The row's slot: it clips the row at the frame's top edge, so revealed content rises out of it.
  const clip = document.createElement("div");
  clip.className = "lalala-tabs-clip";
  clip.append(row);
  frameEl.append(clip, lead);
}

export type PresenceBarHosts = {
  readonly slot: HTMLElement | null;
  readonly lead: HTMLElement | null;
  readonly input: { readonly tab: HTMLElement; readonly panel: HTMLElement; readonly bar: HTMLElement } | null;
  readonly mic: HTMLElement | null;
  readonly canvas: HTMLElement | null;
  readonly settings: HTMLElement | null;
  /** The call room, where START CALL sits. */
  readonly room: HTMLElement | null;
};

/**
 * Presence's call frame and wave in `root`, driven each frame by `analysis` and `hearing`. Returns the
 * frame, the tab hosts for React portals, and the teardown.
 */
export function mountPresenceBar(
  root: HTMLElement,
  input: {
    readonly onPress: () => void;
    readonly analysis: () => VoiceBarAnalysis | null;
    readonly hearing: () => boolean;
    /** A model download's progress (0..1) for the connecting line, or null. */
    readonly fill?: () => number | null;
  },
): { readonly frame: PresenceFrame; readonly hosts: PresenceBarHosts; readonly dispose: () => void } | null {
  root.innerHTML = BAR_HTML;
  const bar = root.querySelector<HTMLElement>("[data-bar]");
  const frameEl = root.querySelector<HTMLElement>("[data-frame]");
  const canvas = root.querySelector<HTMLCanvasElement>("[data-light]");
  if (bar === null || frameEl === null || canvas === null) return null;
  makeStatusTab(frameEl);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = createFrame({ bar, frame: frameEl, reduced });
  startSweepClock(reduced);
  const light = createCallWave(canvas, {
    reduced,
    wash: root.querySelector("[data-wash]"),
    state: () => ({ look: frame.look, audio: frame.audio, reading: false, open: false }),
    // The glyph is hidden: no level bars to move.
    bars: () => null,
  });

  const talk = root.querySelector<HTMLButtonElement>("[data-talk]");
  const onTalk = () => input.onPress();
  talk?.addEventListener("click", onTalk);
  const inputSlot = root.querySelector<HTMLElement>(".lalala-input-slot");
  // The map square at the body's right end, filled by the canvas (extras/CanvasMap).
  const map = document.createElement("div");
  map.className = "fr-map";
  map.dataset.lalalaMap = "";
  (frameEl.querySelector(".fr-in") ?? frameEl).append(map);
  const hosts: PresenceBarHosts = {
    slot: root.querySelector<HTMLElement>("[data-slot]"),
    lead: root.querySelector<HTMLElement>(".lalala-lead"),
    input: inputSlot === null ? null : { tab: inputSlot, panel: frameEl, bar },
    mic: root.querySelector<HTMLElement>(".lalala-mic-slot"),
    canvas: root.querySelector<HTMLElement>(".lalala-canvas-slot"),
    settings: root.querySelector<HTMLElement>(".lalala-settings-slot"),
    room: root.querySelector<HTMLElement>(".bar-line"),
  };

  const wash = root.querySelector<HTMLElement>("[data-wash]");
  let voice = 0;
  let voiceSet = 0;
  let voiceAt = performance.now();
  let stopped = false;
  let handle = 0;
  const tick = () => {
    if (stopped) return;
    const analysis = input.analysis();
    light.setFill(input.fill?.() ?? null);
    light.frame(analysis?.levels ?? {}, analysis?.spectrum ?? null);
    const now = performance.now();
    const dt = Math.min(0.05, (now - voiceAt) / 1000);
    voiceAt = now;
    const db = 20 * Math.log10((analysis?.levels.input ?? 0) / 3 + 1e-9);
    const to =
      input.hearing() && !reduced
        ? Math.min(1, Math.max(0, (db - VOICE_QUIET_DB) / (VOICE_FULL_DB - VOICE_QUIET_DB)))
        : 0;
    voice += (to - voice) * (1 - Math.exp(-(to > voice ? VOICE_RISE : VOICE_FALL) * dt));
    const shown = voice < VOICE_STEP ? 0 : voice;
    if (
      wash !== null &&
      (Math.abs(shown - voiceSet) >= VOICE_STEP || (shown === 0) !== (voiceSet === 0))
    ) {
      voiceSet = shown;
      wash.style.setProperty("--lalala-voice", shown.toFixed(3));
    }
    handle =
      analysis === null && light.resting
        ? window.setTimeout(tick, REST_MS)
        : window.requestAnimationFrame(tick);
  };
  tick();
  return {
    frame,
    hosts,
    dispose: () => {
      stopped = true;
      window.clearTimeout(handle);
      window.cancelAnimationFrame(handle);
      talk?.removeEventListener("click", onTalk);
      showSweep(false);
      root.replaceChildren();
    },
  };
}

/** Tells the frame what voice is doing, and the bar's talk button and quiet line what to say. */
export function showPresenceState(
  root: HTMLElement,
  frame: PresenceFrame | null,
  input: {
    readonly state: VoiceBarState;
    readonly label: string;
    readonly disabled: boolean;
    readonly message: string | null;
    /** Streamer mode: `message` arrives scrambled and is drawn pixelated (an error can name a host or a path). */
    readonly streamer: boolean;
  },
) {
  frame?.state(PRESENCE_STATE[input.state]);
  showSweep(PRESENCE_STATE[input.state].line === "thinking");
  const talk = root.querySelector<HTMLButtonElement>("[data-talk]");
  if (talk) {
    talk.setAttribute("aria-label", input.label);
    talk.disabled = input.disabled;
  }
  // One quiet line over the frame, only for something the user must know (Presence's .bar-incoming).
  const incoming = root.querySelector<HTMLElement>("[data-incoming]");
  if (incoming) {
    incoming.hidden = input.message === null;
    const line = document.createElement("li");
    const text = document.createElement("span");
    if (input.streamer) text.dataset.streamerText = "";
    text.textContent = input.message ?? "";
    line.append(text);
    incoming.replaceChildren(...(input.message === null ? [] : [line]));
  }
}
