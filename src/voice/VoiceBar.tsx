import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type CallWaveLevels, type CallWaveSpectrum, createCallWave } from "./presence/callwave";
import { createFrame, type PresenceFrame } from "./presence/frame";
import { CanvasTabs } from "./CanvasSwitcher";
import { useUpdateReady } from "./phoneUpdate";
import { VoiceInput, type VoiceInputSubmit } from "./VoiceInput";
import { voiceLog } from "./voiceLog";
import { showSweep, startSweepClock } from "./voiceSounds";
import { BAR_HTML } from "./presence/markup";
import "./presence/presence.css";
import "./voiceBar.css";

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
const PRESENCE_STATE: Record<VoiceBarState, { line: string; voice: string }> = {
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
// The user's voice fills the listening wash (voiceBar.css --t3voice-voice): their frame level in dB from the
// room's quiet to a close voice, quick to rise, slow to fall, written only when it moves.
const VOICE_QUIET_DB = -50;
const VOICE_FULL_DB = -24;
const VOICE_RISE = 14;
const VOICE_FALL = 2.5;
const VOICE_STEP = 0.01;

/**
 * The tabs over the map: Presence's state tab holds only the timer (its
 * glyph stays inside, hidden, so frame.js still finds it), INPUT left of it, and apart from them the lead
 * tab at the bar's left end, which takes UPDATE when an update waits for the call to end. Moved before createFrame; frame.js still
 * finds each part by its selector.
 */
function makeStatusTab(frameEl: HTMLElement) {
  const tab = frameEl.querySelector<HTMLElement>("[data-tab]");
  const timer = frameEl.querySelector<HTMLElement>("[data-timer]");
  if (tab === null || timer === null) return;
  tab.append(timer);
  const lead = document.createElement("span");
  lead.className = "t3voice-lead";
  // "› INPUT" (VoiceInput) leads the row, left of UPDATE and the time.
  const input = document.createElement("span");
  input.className = "t3voice-input-slot";
  const row = document.createElement("div");
  row.className = "t3voice-tabs";
  // The mic mute tab, left of "+".
  const mic = document.createElement("span");
  mic.className = "t3voice-mic-slot";
  // The canvas's name and Follow, left of the mic; like the rest, only in a call.
  const canvas = document.createElement("span");
  canvas.className = "t3voice-canvas-slot";
  row.append(canvas, mic, input, tab);
  // The row's slot: it clips the row at the frame's top edge, so it slides in and out behind the bar.
  const clip = document.createElement("div");
  clip.className = "t3voice-tabs-clip";
  clip.append(row);
  frameEl.append(clip, lead);
}

/**
 * The voice control: Presence's call frame itself (presence/, green instead of red), driven by t3voice's state and audio.
 * The room is the one tap target (no key: T3's composer is right there); `toggle` sits in a small
 * tab on the top edge at the left.
 */
export function VoiceBar(props: {
  readonly state: VoiceBarState;
  readonly message: string | null;
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
  /** Small controls for the slot tab on the top edge. */
  readonly toggle?: ReactNode;
  /** This frame's audio for the wave; null while voice is off. */
  readonly analysis?: () => VoiceBarAnalysis | null;
  /** Bump to show Presence's "stopped" look (a reply cut off by the user). */
  readonly stoppedAt?: number;
  /** Typed text and pictures for the voice thread (the "› INPUT" tab); none, no tab. */
  readonly onSubmit?: VoiceInputSubmit;
  /** A call is on: only then is INPUT there (out of a call it is tucked away). */
  readonly live?: boolean;
  /** The user's mic is muted; the mic tab left of "+" shows it and `onMute` flips it. */
  readonly muted?: boolean;
  readonly onMute?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PresenceFrame | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const [micHost, setMicHost] = useState<HTMLElement | null>(null);
  const [inputHosts, setInputHosts] = useState<{
    readonly tab: HTMLElement;
    readonly panel: HTMLElement;
    readonly bar: HTMLElement;
  } | null>(null);
  const [canvasHost, setCanvasHost] = useState<HTMLElement | null>(null);
  const updateReady = useUpdateReady();

  const press = useEffectEvent(() => props.onPress());
  const readAnalysis = useEffectEvent(() => props.analysis?.() ?? null);
  const hearing = useEffectEvent(() => props.state === "hearing");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts Presence's own DOM-driven frame and wave once; they live outside React
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    root.innerHTML = BAR_HTML;
    const bar = root.querySelector<HTMLElement>("[data-bar]");
    const frameEl = root.querySelector<HTMLElement>("[data-frame]");
    const canvas = root.querySelector<HTMLCanvasElement>("[data-light]");
    if (bar === null || frameEl === null || canvas === null) return;
    makeStatusTab(frameEl);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = createFrame({ bar, frame: frameEl, reduced });
    frameRef.current = frame;
    startSweepClock(reduced);
    const light = createCallWave(canvas, {
      reduced,
      wash: root.querySelector("[data-wash]"),
      state: () => ({ look: frame.look, audio: frame.audio, reading: false, open: false }),
      // The glyph is hidden: no level bars to move.
      bars: () => null,
    });

    const talk = root.querySelector<HTMLButtonElement>("[data-talk]");
    const onTalk = () => press();
    talk?.addEventListener("click", onTalk);
    setSlot(root.querySelector<HTMLElement>("[data-slot]"));
    setLead(root.querySelector<HTMLElement>(".t3voice-lead"));
    const inputSlot = root.querySelector<HTMLElement>(".t3voice-input-slot");
    setInputHosts(inputSlot === null ? null : { tab: inputSlot, panel: frameEl, bar });
    // The map square at the body's right end, filled by the canvas (extras/CanvasMap), which this event wakes.
    const map = document.createElement("div");
    map.className = "fr-map";
    map.dataset.t3voiceMap = "";
    (frameEl.querySelector(".fr-in") ?? frameEl).append(map);
    setMicHost(root.querySelector<HTMLElement>(".t3voice-mic-slot"));
    setCanvasHost(root.querySelector<HTMLElement>(".t3voice-canvas-slot"));
    document.dispatchEvent(new Event("t3voice:bar"));

    const wash = root.querySelector<HTMLElement>("[data-wash]");
    let voice = 0;
    let voiceSet = 0;
    let voiceAt = performance.now();
    let stopped = false;
    let handle = 0;
    const tick = () => {
      if (stopped) return;
      const analysis = readAnalysis();
      light.frame(analysis?.levels ?? {}, analysis?.spectrum ?? null);
      const now = performance.now();
      const dt = Math.min(0.05, (now - voiceAt) / 1000);
      voiceAt = now;
      const db = 20 * Math.log10((analysis?.levels.input ?? 0) / 3 + 1e-9);
      const to =
        hearing() && !reduced
          ? Math.min(1, Math.max(0, (db - VOICE_QUIET_DB) / (VOICE_FULL_DB - VOICE_QUIET_DB)))
          : 0;
      voice += (to - voice) * (1 - Math.exp(-(to > voice ? VOICE_RISE : VOICE_FALL) * dt));
      const shown = voice < VOICE_STEP ? 0 : voice;
      if (
        wash !== null &&
        (Math.abs(shown - voiceSet) >= VOICE_STEP || (shown === 0) !== (voiceSet === 0))
      ) {
        voiceSet = shown;
        wash.style.setProperty("--t3voice-voice", shown.toFixed(3));
      }
      handle =
        analysis === null && light.resting
          ? window.setTimeout(tick, REST_MS)
          : window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(handle);
      window.cancelAnimationFrame(handle);
      talk?.removeEventListener("click", onTalk);
      showSweep(false);
      frameRef.current = null;
      root.replaceChildren();
      document.dispatchEvent(new Event("t3voice:bar"));
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells Presence's frame (DOM, outside React) what voice is doing
  useEffect(() => {
    frameRef.current?.state(PRESENCE_STATE[props.state]);
    showSweep(PRESENCE_STATE[props.state].line === "thinking");
    const root = rootRef.current;
    const talk = root?.querySelector<HTMLButtonElement>("[data-talk]");
    if (talk) {
      talk.setAttribute("aria-label", props.label);
      talk.disabled = props.disabled;
    }
    // One quiet line over the frame, only for something the user must know (Presence's .bar-incoming).
    const incoming = root?.querySelector<HTMLElement>("[data-incoming]");
    if (incoming) {
      incoming.hidden = props.message === null;
      const line = document.createElement("li");
      line.textContent = props.message ?? "";
      incoming.replaceChildren(...(props.message === null ? [] : [line]));
    }
  }, [props.state, props.label, props.disabled, props.message]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Presence's stopped look when the user cuts a reply off
  useEffect(() => {
    if (props.stoppedAt) frameRef.current?.stopped();
  }, [props.stoppedAt]);

  return (
    <>
      <div
        ref={rootRef}
        data-t3voice-presence=""
        // PhoneBuildReload reads this: no reload unless voice is off.
        data-voice-state={props.state}
      />
      {slot !== null ? createPortal(props.toggle, slot) : null}
      {inputHosts !== null && props.onSubmit ? (
        <VoiceInput
          tabHost={inputHosts.tab}
          panelHost={inputHosts.panel}
          bar={inputHosts.bar}
          live={props.live ?? false}
          onSubmit={props.onSubmit}
        />
      ) : null}
      {canvasHost !== null && inputHosts !== null ? (
        <CanvasTabs
          tabHost={canvasHost}
          panelHost={inputHosts.panel}
          bar={inputHosts.bar}
          live={props.live ?? false}
        />
      ) : null}
      {micHost !== null && props.onMute && props.live
        ? createPortal(
            <button
              type="button"
              data-t3voice-mic=""
              data-muted={props.muted ? "" : undefined}
              aria-pressed={props.muted ?? false}
              aria-label={props.muted ? "Unmute microphone" : "Mute microphone"}
              onClick={props.onMute}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" />
                {props.muted ? <path d="M4 3l16 18" /> : null}
              </svg>
            </button>,
            micHost,
          )
        : null}
      {lead !== null && updateReady
        ? createPortal(
            // An update waits; during a call it applies only on this tap. It fills the lead
            // tab at the bar's left end, on desktop and phone alike (voiceBar.css).
            <button
              type="button"
              data-t3voice-update=""
              onClick={() => {
                voiceLog("system", "reload", { why: "update chip tapped" });
                window.location.reload();
              }}
            >
              <span>update</span>
            </button>,
            lead,
          )
        : null}
    </>
  );
}
