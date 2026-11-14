import {
  type CSSProperties,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { observeResize } from "~/lib/observeResize";

import { type CallWaveLevels, type CallWaveSpectrum, createCallWave } from "./presence/callwave";
import { createFrame, type PresenceFrame } from "./presence/frame";
import { CanvasTabs } from "./CanvasSwitcher";
import { CompactingDefrag } from "./extras/CompactingDefrag";
import { useUpdateReady } from "./phoneUpdate";
import { SecretAsks } from "./SecretAsk";
import { TOPIC_EVENT, TOPIC_SOUND_FALLBACK_MS } from "./player";
import { type VoiceFileUpload, VoiceInput, type VoiceInputSubmit } from "./VoiceInput";
import {
  CONNECTED_HOLD_MS,
  closeVoiceSettings,
  openVoiceSettings,
  type SettingsPage,
  VoiceSettings,
} from "./VoiceSettings";
import { voiceLog } from "./voiceLog";
import { showSweep, startSweepClock } from "./voiceSounds";
import { type T3Link, useT3Link } from "./t3Link";
import { BAR_HTML } from "./presence/markup";
import { errorTag, type ErrorTag, OFFLINE_TEXT, UNREACHABLE_TEXT } from "./voiceErrors";
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

/** One speech model loading; `total` 0 while its size is unknown (the room shows it without numbers). */
export type VoiceBarModel = {
  readonly name: string;
  readonly loaded: number;
  readonly total: number;
  readonly done: boolean;
};

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
// the user's voice fills the listening wash (its .lalala-voice layer): his frame level in dB from the room's
// quiet to a close voice, quick to rise, slow to fall, written only when it moves, as opacity and
// transform on that layer (composite-only).
const VOICE_QUIET_DB = -50;
const VOICE_FULL_DB = -24;
const VOICE_RISE = 14;
const VOICE_FALL = 2.5;
const VOICE_STEP = 0.01;
// Below this the room counts as quiet: no wash.
const VOICE_FLOOR = 0.05;
const VOICE_STILL = 0.6;
const VOICE_HOLD_MS = 300;

/**
 * The tabs over the map (the user, 3 Nov, round 6 B2): Presence's state tab holds only the timer (its
 * glyph stays inside, hidden, so frame.js still finds it), INPUT left of it, and apart from them the lead
 * tab at the bar's left end: UPDATE when a new phone build waits. Moved before createFrame; frame.js still
 * finds each part by its selector.
 */
function makeStatusTab(frameEl: HTMLElement) {
  const tab = frameEl.querySelector<HTMLElement>("[data-tab]");
  const timer = frameEl.querySelector<HTMLElement>("[data-timer]");
  if (tab === null || timer === null) return;
  tab.append(timer);
  // Presence hides both from readers; here the time is the call's visible duration (hidden out of a call).
  tab.removeAttribute("aria-hidden");
  timer.removeAttribute("aria-hidden");
  timer.setAttribute("role", "timer");
  timer.setAttribute("aria-label", "Call time");
  const lead = document.createElement("span");
  lead.className = "lalala-lead";
  // Right to left from the time (the user, 8 Nov): the input (a keyboard tab, VoiceInput), the mic, the
  // canvases (a layers tab), then the settings gear.
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
  row.append(settings, canvas, mic, input, tab);
  // The row's slot: it clips the row at the frame's top edge, so revealed content rises out of it.
  const clip = document.createElement("div");
  clip.className = "lalala-tabs-clip";
  clip.append(row);
  frameEl.append(clip, lead);
}

/** How long a fresh pairing shows Connected before the settings close. */

/**
 * The voice control: Presence's call frame itself (presence/, copied by
 * scripts/lalala-presence-sync.mjs, green instead of red), driven by t3 voice's state and audio.
 * The room is the one tap target (no key: T3's composer is right there).
 */
export function VoiceBar(props: {
  readonly state: VoiceBarState;
  readonly message: string | null;
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
  /** This frame's audio for the wave; null while voice is off. */
  readonly analysis?: () => VoiceBarAnalysis | null;
  /** Bump to show Presence's "stopped" look (a reply cut off by the user). */
  readonly stoppedAt?: number;
  /** Typed text, pictures and files for the voice thread (the input tab); none, no tab. */
  readonly onSubmit?: VoiceInputSubmit;
  /** T3's attachment upload for files in the input; none, pictures only. */
  readonly upload?: VoiceFileUpload | undefined;
  /** A call is on: the row's call tabs are live (out of a call they are empty, inert slots). */
  readonly live?: boolean;
  /** the user's mic is muted; the mic tab shows it and `onMute` flips it. */
  readonly muted?: boolean;
  readonly onMute?: () => void;
  /** The brain compacting its thread: the wave area shows a defrag paced by the estimate. */
  readonly compacting?: {
    readonly active: boolean;
    readonly startedAt: number | null;
    readonly estimateMs: number;
  };
  /** Speech models downloading: a row each in the room; empty while they load from disk; null once ready. */
  readonly models?: ReadonlyArray<VoiceBarModel> | null;
  /** The settings' pages, in place of the app's (lalala.talk shows only what a browser can do). */
  readonly settings?: ReadonlyArray<SettingsPage>;
  /** In a call, the link to T3 dropped and comes back on its own. */
  readonly reconnecting?: boolean;
  /**
   * The host knows T3 Code can't be reached (lalala.talk): out of a call START CALL gives way to
   * CONNECT TO T3 CODE, which calls this; null while connected. Unset, the bar asks the bridge.
   */
  readonly offline?: (() => void) | null;
  /** The platform took the mic away mid-call; a tap on the room takes it back. */
  readonly paused?: boolean;
  /** A copy on the canvas's states card (extras/BarStates): its T3 link and UPDATE come from
      here, and it leaves the call's shared thinking sweep alone. */
  readonly preview?: { readonly link: T3Link; readonly topicAt: number };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PresenceFrame | null>(null);
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const [micHost, setMicHost] = useState<HTMLElement | null>(null);
  const [inputHosts, setInputHosts] = useState<{
    readonly tab: HTMLElement;
    readonly panel: HTMLElement;
    readonly bar: HTMLElement;
  } | null>(null);
  const [canvasHost, setCanvasHost] = useState<HTMLElement | null>(null);
  const [settingsHost, setSettingsHost] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState<HTMLElement | null>(null);
  // An update starts playing: UPDATE wipes over the room for a moment, the wave running on beneath it.
  // How long it shows (the update sound's length, ms); 0 when it doesn't.
  const [topicMs, setTopicMs] = useState(0);
  // Canvases work without T3 Code; only calls need it. Out of a call the call button says so.
  const realLink = useT3Link();
  const link = props.preview?.link ?? realLink;
  const offline =
    (props.offline === undefined ? link === "disconnected" : props.offline !== null) && !props.live;
  // The amber button was tapped: once the pairing links T3, Connected shows for a moment and the
  // settings close onto the normal START CALL. Closing them first drops that intent.
  const closeOnConnectRef = useRef(false);
  const updateReady = useUpdateReady();

  // Nothing floats over the bar (the user, 9 Nov): what it has to say sits in the room, over the wave.
  const note: Note | null =
    props.reconnecting
      ? { kind: "reconnecting" }
      : props.state === "error"
      ? props.message === UNREACHABLE_TEXT
        ? { kind: "reconnecting" }
        : props.message === OFFLINE_TEXT
          ? { kind: "holding" }
          : { kind: "error", error: errorTag(props.message ?? "", props.live ?? false) }
      : props.models
        ? props.models.length > 0
          ? { kind: "models", models: props.models }
          : { kind: "connecting", text: "Loading voice" }
        : props.paused
          ? { kind: "paused" }
          : topicMs > 0
            ? { kind: "topic", ms: topicMs }
            : props.state === "connecting"
              ? { kind: "connecting", text: "Connecting" }
              : null;

  const press = useEffectEvent(() => props.onPress());
  const readAnalysis = useEffectEvent(() => props.analysis?.() ?? null);
  const hearing = useEffectEvent(() => props.state === "hearing");
  const compacting = useEffectEvent(() => props.compacting?.active === true);
  const fill = useEffectEvent(() => downloadFill(props.models));
  const loading = useEffectEvent(() => (props.models?.length ?? 0) > 0);
  const previewed = props.preview !== undefined;
  const previewing = useEffectEvent(() => previewed);
  const topicAt = props.preview?.topicAt;

  // The phone sizes follow the page's width in its own CSS px, which a viewport media query misses
  // under CSS zoom (a 360 px page in a 1080 px window). Before paint, so a phone never sees desktop sizes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the page's layout width, which React does not own
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    // The bar's own document: the states card renders it into a frame of its own width.
    const page = root.ownerDocument.documentElement;
    const measure = () => root.toggleAttribute("data-lalala-compact", page.offsetWidth < 640);
    measure();
    return observeResize([page], measure);
  }, []);

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
    // Just "Start" on the plate, no power mark (the user, 8 Nov).
    frameEl.querySelector(".fr-plate")?.replaceChildren("start");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = createFrame({ bar, frame: frameEl, reduced });
    frameRef.current = frame;
    if (!previewing()) startSweepClock(reduced);
    const hiddenFor = { look: "", site: "", loading: false, hidden: false };
    const light = createCallWave(canvas, {
      reduced,
      wash: root.querySelector("[data-wash]"),
      // A look may hide the wave for some states (voiceBar.css decides; the cyberpunk look while connecting
      // and with no signal), and the compacting defrag covers it: then the wave draws nothing at all. Read once
      // per state, not every frame.
      state: () => {
        // The site's look can change mid-state too.
        const site = document.documentElement.dataset.lalaLook ?? "";
        // Models loading show the connecting ASCII line filling (voiceBar.css), which a look may otherwise hide.
        if (
          frame.look !== hiddenFor.look ||
          site !== hiddenFor.site ||
          loading() !== hiddenFor.loading
        ) {
          hiddenFor.look = frame.look;
          hiddenFor.site = site;
          hiddenFor.loading = loading();
          hiddenFor.hidden = getComputedStyle(canvas).visibility === "hidden";
        }
        return {
          look: frame.look,
          audio: frame.audio,
          reading: false,
          open: compacting() || hiddenFor.hidden,
        };
      },
      // The glyph is hidden: no level bars to move.
      bars: () => null,
    });

    const talk = root.querySelector<HTMLButtonElement>("[data-talk]");
    const onTalk = () => press();
    talk?.addEventListener("click", onTalk);
    setLead(root.querySelector<HTMLElement>(".lalala-lead"));
    const inputSlot = root.querySelector<HTMLElement>(".lalala-input-slot");
    setInputHosts(inputSlot === null ? null : { tab: inputSlot, panel: frameEl, bar });
    // The map square at the body's right end, filled by the canvas (extras/CanvasMap), which this event wakes.
    const map = document.createElement("div");
    map.className = "fr-map";
    map.dataset.lalalaMap = "";
    (frameEl.querySelector(".fr-in") ?? frameEl).append(map);
    setMicHost(root.querySelector<HTMLElement>(".lalala-mic-slot"));
    setCanvasHost(root.querySelector<HTMLElement>(".lalala-canvas-slot"));
    setSettingsHost(root.querySelector<HTMLElement>(".lalala-settings-slot"));
    setRoom(root.querySelector<HTMLElement>(".bar-line"));
    document.dispatchEvent(new Event("lalala:bar"));

    const voiceEl = document.createElement("i");
    voiceEl.className = "lalala-voice";
    // Inside Presence's wash: his voice glows within the room's resting light (the user, 9 Nov).
    root.querySelector("[data-wash]")?.append(voiceEl);
    let voice = 0;
    let voiceSet = 0;
    let voiceAt = performance.now();
    let heardAt = -Infinity;
    let stopped = false;
    let handle = 0;
    const tick = () => {
      if (stopped) return;
      const analysis = readAnalysis();
      light.setFill(fill());
      light.frame(analysis?.levels ?? {}, analysis?.spectrum ?? null);
      const now = performance.now();
      const dt = Math.min(0.05, (now - voiceAt) / 1000);
      voiceAt = now;
      const db = 20 * Math.log10((analysis?.levels.input ?? 0) / 3 + 1e-9);
      if (hearing()) heardAt = now;
      // Reduced motion: a still wash while the user talks, held a moment so a flickering voice doesn't blink it.
      const to = reduced
        ? now - heardAt < VOICE_HOLD_MS
          ? VOICE_STILL
          : 0
        : hearing()
          ? Math.min(1, Math.max(0, (db - VOICE_QUIET_DB) / (VOICE_FULL_DB - VOICE_QUIET_DB)))
          : 0;
      voice = reduced
        ? to
        : voice + (to - voice) * (1 - Math.exp(-(to > voice ? VOICE_RISE : VOICE_FALL) * dt));
      const shown = voice < VOICE_FLOOR ? 0 : voice;
      if (Math.abs(shown - voiceSet) >= VOICE_STEP || (shown === 0) !== (voiceSet === 0)) {
        voiceSet = shown;
        voiceEl.style.opacity = shown.toFixed(3);
        voiceEl.style.transform = `scale(${(0.45 + 0.7 * shown).toFixed(3)}, ${(0.75 + 0.4 * shown).toFixed(3)})`;
      }
      // Nothing visible moves (out of a call at rest, or the wave hidden and the user quiet): poll instead of
      // drawing every frame; his voice starts the frames again within one poll.
      const still =
        !light.fading &&
        ((analysis === null && light.resting) ||
          ((hiddenFor.hidden || compacting()) && !hearing() && voiceSet === 0));
      handle = still ? window.setTimeout(tick, REST_MS) : window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(handle);
      window.cancelAnimationFrame(handle);
      talk?.removeEventListener("click", onTalk);
      if (!previewing()) showSweep(false);
      frameRef.current = null;
      root.replaceChildren();
      document.dispatchEvent(new Event("lalala:bar"));
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells Presence's frame (DOM, outside React) what voice is doing
  useEffect(() => {
    // An error during a call is Presence's reconnecting: no signal shows, the call's clock keeps running.
    frameRef.current?.state(
      props.state === "error" && props.live
        ? { line: "error", voice: "reconnecting" }
        : PRESENCE_STATE[props.state],
    );
    if (!previewed) showSweep(PRESENCE_STATE[props.state].line === "thinking");
    const root = rootRef.current;
    const talk = root?.querySelector<HTMLButtonElement>("[data-talk]");
    if (talk) {
      talk.setAttribute("aria-label", props.label);
      talk.disabled = props.disabled;
    }
  }, [props.state, props.live, props.label, props.disabled, previewed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the bridge linking T3 (after pairing) closes the settings the amber button opened
  useEffect(() => {
    if (link !== "connected" || !closeOnConnectRef.current) return;
    closeOnConnectRef.current = false;
    const timer = window.setTimeout(closeVoiceSettings, CONNECTED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [link]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Presence's stopped look when the user cuts a reply off
  useEffect(() => {
    if (props.stoppedAt) frameRef.current?.stopped();
  }, [props.stoppedAt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the player (outside React) announces a new topic as it starts playing; a preview's comes from its card
  useEffect(() => {
    let timer = 0;
    const show = (event?: Event) => {
      window.clearTimeout(timer);
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const ms = typeof detail === "number" && detail > 0 ? detail : TOPIC_SOUND_FALLBACK_MS;
      setTopicMs(ms);
      timer = window.setTimeout(() => setTopicMs(0), ms);
    };
    if (topicAt === undefined) document.addEventListener(TOPIC_EVENT, show);
    else if (topicAt > 0) show();
    return () => {
      document.removeEventListener(TOPIC_EVENT, show);
      window.clearTimeout(timer);
      setTopicMs(0);
    };
  }, [topicAt]);

  return (
    <>
      <div
        ref={rootRef}
        data-lalala-presence=""
        // PhoneBuildReload reads this: no reload unless voice is off.
        data-voice-state={props.state}
        // The call's tabs (input, mic) are live by this, not by Presence's timer.
        data-lalala-live={props.live ? "" : undefined}
        data-lalala-off={offline ? "" : undefined}
      />
      {/* A look may show connecting and thinking only as a word drawn in CSS; readers hear it here. */}
      <span data-lalala-sr="" role="status">
        {props.state === "connecting"
          ? "Connecting"
          : props.state === "thinking" || props.state === "transcribing"
            ? "Thinking"
            : ""}
      </span>
      {inputHosts !== null && note !== null
        ? createPortal(
            <RoomNote note={note} compacting={props.compacting?.active === true} />,
            inputHosts.panel,
          )
        : null}
      {room !== null && props.compacting
        ? createPortal(<CompactingDefrag {...props.compacting} />, room)
        : null}
      {room !== null && offline
        ? createPortal(
            // Where START CALL sits (the user, 8 Nov: one compact amber button); it opens the pairing.
            <div data-lalala-offline="">
              <button
                type="button"
                onClick={() => {
                  if (props.offline) return props.offline();
                  closeOnConnectRef.current = true;
                  openVoiceSettings("Connection");
                }}
              >
                Connect to T3 Code
              </button>
            </div>,
            room,
          )
        : null}
      {inputHosts !== null && props.onSubmit ? (
        <VoiceInput
          tabHost={inputHosts.tab}
          panelHost={inputHosts.panel}
          bar={inputHosts.bar}
          onSubmit={props.onSubmit}
          upload={props.upload}
        />
      ) : null}
      {canvasHost !== null && inputHosts !== null ? (
        <CanvasTabs tabHost={canvasHost} panelHost={inputHosts.panel} bar={inputHosts.bar} />
      ) : null}
      {/* Only the real bar: a preview copy (the bar states card) would show and answer it too. */}
      {inputHosts !== null && !previewed ? (
        <SecretAsks host={inputHosts.panel} bar={inputHosts.bar} />
      ) : null}
      {micHost !== null && props.onMute
        ? createPortal(
            <button
              type="button"
              data-lalala-mic=""
              data-lalala-tab=""
              data-muted={props.muted ? "" : undefined}
              aria-pressed={props.muted ?? false}
              aria-label="Mute microphone"
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
      {settingsHost !== null ? (
        <VoiceSettings tabHost={settingsHost} pages={props.settings} />
      ) : null}
      {lead !== null && updateReady
        ? createPortal(
            // A newer phone build waits; during a call it applies only on this tap. It fills the lead
            // tab at the bar's left end, on desktop and phone alike (voiceBar.css).
            <button
              type="button"
              data-lalala-update=""
              aria-label="Update"
              onClick={() => {
                voiceLog("system", "reload", { why: "update chip tapped" });
                window.location.reload();
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                <path d="M20 4v4.5h-4.5" />
              </svg>
            </button>,
            lead,
          )
        : null}
    </>
  );
}

type Note =
  | { readonly kind: "error"; readonly error: ErrorTag }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "holding" }
  | { readonly kind: "models"; readonly models: ReadonlyArray<VoiceBarModel> }
  | { readonly kind: "paused" }
  | { readonly kind: "topic"; readonly ms: number }
  | { readonly kind: "connecting"; readonly text: string };

const mb = (bytes: number) => Math.round(bytes / 1e6);

/** All the models' bytes so far against all their sizes, for the connecting line's fill; null while unknown. */
function downloadFill(models: ReadonlyArray<VoiceBarModel> | null | undefined) {
  let loaded = 0;
  let total = 0;
  for (const model of models ?? []) {
    loaded += model.loaded;
    total += model.total;
  }
  return total > 0 ? loaded / total : null;
}

/**
 * What the bar has to say, in its room (on the frame, over the wave): a small tag in the room's centre
 * beside Presence's glitch (an error's few words, RECONNECTING, OFFLINE · HOLDING YOUR WORDS) or its ASCII line (CONNECTING), the models loading (a line each on the connecting ASCII line,
 * which fills from the left with their bytes: the user's pick, 6 Nov), the paused mic, UPDATE.
 */
function RoomNote({ note, compacting }: { readonly note: Note; readonly compacting: boolean }) {
  return (
    <div data-lalala-note={note.kind} role="status">
      {note.kind === "error" ? (
        <b data-lalala-tag="" aria-label={note.error.said}>
          <span>{note.error.tag}</span>
          {note.error.hint === null ? null : <small>{note.error.hint}</small>}
        </b>
      ) : note.kind === "reconnecting" ? (
        <b data-lalala-tag="" aria-label="Lost the connection. Reconnecting.">
          <span>Reconnecting</span>
        </b>
      ) : note.kind === "holding" ? (
        <b data-lalala-tag="" aria-label={OFFLINE_TEXT}>
          <span>Offline</span>
          <small>Holding your words</small>
        </b>
      ) : note.kind === "paused" ? (
        <b
          data-lalala-plate=""
          aria-label="Mic paused: another app took the audio. Tap to resume."
        >
          Tap to resume mic
        </b>
      ) : note.kind === "connecting" ? (
        // The status line under the bar already reads "Connecting" out.
        <b data-lalala-tag="" aria-hidden="true">
          <span>{note.text}</span>
        </b>
      ) : note.kind === "topic" ? (
        <b style={{ "--lalala-topic-ms": `${note.ms}ms` } as CSSProperties}>Update</b>
      ) : (
        <ol aria-label="Loading speech models">
          {note.models.map((model, index) => (
            <li key={model.name} data-done={model.done ? "" : undefined}>
              <span>
                {note.models.length > 1 ? `${index + 1} of ${note.models.length} \u00b7 ` : ""}
                {model.name}
              </span>
              <span>
                {model.done
                  ? `\u2713 ${model.total > 0 ? `${mb(model.total)} MB` : "ready"}`
                  : model.total > 0 && model.loaded < model.total
                    ? `${mb(model.loaded)} / ${mb(model.total)} MB`
                    : "loading\u2026"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {/* The rows take the room; a compaction meanwhile is this small tag at its right end. */}
      {note.kind === "models" && compacting ? (
        <b data-lalala-compacting="" data-cut="">
          Compacting
        </b>
      ) : null}
    </div>
  );
}
