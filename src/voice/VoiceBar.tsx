import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ModelProgress } from "./adapters";
import type { PresenceFrame } from "./presence/frame";
import { CanvasTabs } from "./CanvasSwitcher";
import { CompactingDefrag } from "./extras/CompactingDefrag";
import { useUpdateReady } from "./phoneUpdate";
import { TOPIC_EVENT } from "./player";
import {
  mountPresenceBar,
  type PresenceBarHosts,
  showPresenceState,
  type VoiceBarAnalysis,
  type VoiceBarState,
} from "./presenceBar";
import { type VoiceFileUpload, VoiceInput, type VoiceInputSubmit } from "./VoiceInput";
import { type SettingsPage, VoiceSettings } from "./VoiceSettings";
import { voiceLog } from "./voiceLog";
import { errorTag, type ErrorTag, OFFLINE_TEXT, UNREACHABLE_TEXT } from "./voiceErrors";
import "./presence/presence.css";
import "./voiceBar.css";

export type { VoiceBarAnalysis, VoiceBarState };

/**
 * The voice control: Presence's call frame itself (presence/, green instead of red), driven by lalala's state and audio.
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
  /** The user's mic is muted; the mic tab shows it and `onMute` flips it. */
  readonly muted?: boolean;
  readonly onMute?: () => void;
  /** The brain compacting its thread: the wave area shows a defrag paced by the estimate. */
  readonly compacting?: {
    readonly active: boolean;
    readonly startedAt: number | null;
    readonly estimateMs: number;
  };
  /** The settings' pages, in place of the app's (lalala.talk shows only what a browser can do). */
  readonly settings?: ReadonlyArray<SettingsPage>;
  /** Models the call is downloading (lalala.talk's in-browser speech): a line each in the room, on the
      connecting ASCII line that fills with their bytes; null once ready. */
  readonly models?: ReadonlyArray<ModelProgress> | null;
  /** The platform took the mic away mid-call; a tap on the room takes it back. */
  readonly paused?: boolean;
  /** In a call, the link to T3 dropped and comes back on its own. */
  readonly reconnecting?: boolean;
  /**
   * T3 Code can't be reached and no call is on: START CALL gives way to one compact amber
   * CONNECT TO T3 CODE button, which calls this. Canvases work on as they are.
   */
  readonly offline?: (() => void) | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PresenceFrame | null>(null);
  const [hosts, setHosts] = useState<PresenceBarHosts | null>(null);
  const updateReady = useUpdateReady();

  const press = useEffectEvent(() => props.onPress());
  const readAnalysis = useEffectEvent(() => props.analysis?.() ?? null);
  const hearing = useEffectEvent(() => props.state === "hearing");
  const fill = useEffectEvent(() => downloadFill(props.models));
  const compacting = useEffectEvent(() => props.compacting?.active === true);
  // A new topic starts playing: NEW TOPIC wipes over the room for a moment, the wave running on beneath it.
  const [newTopic, setNewTopic] = useState(false);
  // Nothing floats over the bar (9 Nov): what it has to say sits in the room, over the wave.
  const note: Note | null =
    props.state === "error" && props.message === OFFLINE_TEXT
      ? { kind: "holding" }
      : props.reconnecting || (props.state === "error" && props.message === UNREACHABLE_TEXT)
      ? { kind: "reconnecting" }
      : props.state === "error"
        ? { kind: "error", error: errorTag(props.message ?? "", props.live ?? false) }
        : props.models
          ? { kind: "models", models: props.models }
          : props.paused
            ? { kind: "paused" }
            : newTopic
              ? { kind: "topic" }
              : props.state === "connecting"
                ? { kind: "connecting" }
                : null;

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
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts Presence's own DOM-driven frame and wave once; they live outside React
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const bar = mountPresenceBar(root, {
      onPress: press,
      analysis: readAnalysis,
      hearing,
      fill,
      compacting,
    });
    if (bar === null) return;
    frameRef.current = bar.frame;
    setHosts(bar.hosts);
    // The canvas's map (extras/CanvasMap) wakes on this.
    document.dispatchEvent(new Event("lalala:bar"));
    return () => {
      bar.dispose();
      frameRef.current = null;
      document.dispatchEvent(new Event("lalala:bar"));
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells Presence's frame (DOM, outside React) what voice is doing
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    showPresenceState(root, frameRef.current, {
      state: props.state,
      live: props.live ?? false,
      label: props.label,
      disabled: props.disabled,
    });
  }, [props.state, props.live, props.label, props.disabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Presence's stopped look when the user cuts a reply off
  useEffect(() => {
    if (props.stoppedAt) frameRef.current?.stopped();
  }, [props.stoppedAt]);

  const lead = hosts?.lead ?? null;
  const micHost = hosts?.mic ?? null;
  const inputHosts = hosts?.input ?? null;
  const canvasHost = hosts?.canvas ?? null;
  const settingsHost = hosts?.settings ?? null;
  const room = hosts?.room ?? null;
  const offline = props.offline ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the player (outside React) announces a new topic as it starts playing
  useEffect(() => {
    let timer = 0;
    const show = () => {
      window.clearTimeout(timer);
      setNewTopic(true);
      timer = window.setTimeout(() => setNewTopic(false), TOPIC_LABEL_MS);
    };
    document.addEventListener(TOPIC_EVENT, show);
    return () => {
      document.removeEventListener(TOPIC_EVENT, show);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <div
        ref={rootRef}
        data-lalala-presence=""
        // PhoneBuildReload reads this: no reload unless voice is off.
        data-voice-state={props.state}
        // The call's tabs (input, mic) are live by this, not by Presence's timer.
        data-lalala-live={props.live ? "" : undefined}
        data-lalala-off={offline !== null ? "" : undefined}
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
        ? createPortal(<RoomNote note={note} />, inputHosts.panel)
        : null}
      {room !== null && props.compacting
        ? createPortal(<CompactingDefrag {...props.compacting} />, room)
        : null}
      {room !== null && offline !== null
        ? createPortal(
            <div data-lalala-offline="">
              <button type="button" onClick={offline}>
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
            // An update waits; during a call it applies only on this tap. It fills the lead
            // tab at the bar's left end, on desktop and phone alike (voiceBar.css).
            <button
              type="button"
              data-lalala-update=""
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

/** How long NEW TOPIC shows on the frame; voiceBar.css's lalala-topic-wipe runs the same 2.4 s. */
const TOPIC_LABEL_MS = 2_400;

/** All the models' bytes so far against all their sizes, for the connecting line's green fill. */
function downloadFill(models: ReadonlyArray<ModelProgress> | null | undefined) {
  if (!models || models.length === 0) return null;
  let loaded = 0;
  let total = 0;
  for (const model of models) {
    loaded += model.loaded;
    total += model.total;
  }
  return total > 0 ? loaded / total : 0;
}

const mb = (bytes: number) => Math.round(bytes / 1e6);

type Note =
  | { readonly kind: "error"; readonly error: ErrorTag }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "holding" }
  | { readonly kind: "models"; readonly models: ReadonlyArray<ModelProgress> }
  | { readonly kind: "paused" }
  | { readonly kind: "topic" }
  | { readonly kind: "connecting" };

/**
 * What the bar has to say, in its room (on the frame, over the wave): a small tag in the room's centre
 * beside Presence's glitch (an error's few words, RECONNECTING) or its ASCII line (CONNECTING), the models loading (a line each on the connecting ASCII line,
 * which fills from the left with their bytes: the 6 Nov pick), the paused mic, NEW TOPIC.
 */
function RoomNote({ note }: { readonly note: Note }) {
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
        <b data-lalala-plate="" aria-label="Mic paused: another app took the audio. Tap to resume.">
          Tap to resume mic
        </b>
      ) : note.kind === "connecting" ? (
        // The status line under the bar already reads "Connecting" out.
        <b data-lalala-tag="" aria-hidden="true">
          <span>Connecting</span>
        </b>
      ) : note.kind === "topic" ? (
        <b>New topic</b>
      ) : (
        <ol aria-label="Loading speech models">
          {note.models.map((model) => (
            <li key={model.name} data-done={model.done ? "" : undefined}>
              <span>{model.name}</span>
              <span>
                {model.done
                  ? `\u2713 ${model.total > 0 ? `${mb(model.total)} MB` : "ready"}`
                  : model.total > 0
                    ? `${mb(model.loaded)} / ${mb(model.total)} MB`
                    : "loading"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
