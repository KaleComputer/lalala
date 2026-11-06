import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PresenceFrame } from "./presence/frame";
import { CanvasTabs } from "./CanvasSwitcher";
import { useUpdateReady } from "./phoneUpdate";
import {
  mountPresenceBar,
  type PresenceBarHosts,
  showPresenceState,
  type VoiceBarAnalysis,
  type VoiceBarState,
} from "./presenceBar";
import { type VoiceFileUpload, VoiceInput, type VoiceInputSubmit } from "./VoiceInput";
import { VoiceSettings } from "./VoiceSettings";
import { voiceLog } from "./voiceLog";
import "./presence/presence.css";
import "./voiceBar.css";

export type { VoiceBarAnalysis, VoiceBarState };

/**
 * The voice control: Presence's call frame itself (presence/, green instead of red), driven by lalala's state and audio.
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
  /** Typed text, pictures and files for the voice thread (the input tab); none, no tab. */
  readonly onSubmit?: VoiceInputSubmit;
  /** T3's attachment upload for files in the input; none, pictures only. */
  readonly upload?: VoiceFileUpload | undefined;
  /** A call is on: the row's call tabs are live (out of a call they are empty, inert slots). */
  readonly live?: boolean;
  /** The user's mic is muted; the mic tab shows it and `onMute` flips it. */
  readonly muted?: boolean;
  readonly onMute?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PresenceFrame | null>(null);
  const [hosts, setHosts] = useState<PresenceBarHosts | null>(null);
  const updateReady = useUpdateReady();

  const press = useEffectEvent(() => props.onPress());
  const readAnalysis = useEffectEvent(() => props.analysis?.() ?? null);
  const hearing = useEffectEvent(() => props.state === "hearing");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts Presence's own DOM-driven frame and wave once; they live outside React
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const bar = mountPresenceBar(root, { onPress: press, analysis: readAnalysis, hearing });
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
    showPresenceState(root, frameRef.current, props);
  }, [props.state, props.label, props.disabled, props.message]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Presence's stopped look when the user cuts a reply off
  useEffect(() => {
    if (props.stoppedAt) frameRef.current?.stopped();
  }, [props.stoppedAt]);

  const slot = hosts?.slot ?? null;
  const lead = hosts?.lead ?? null;
  const micHost = hosts?.mic ?? null;
  const inputHosts = hosts?.input ?? null;
  const canvasHost = hosts?.canvas ?? null;
  const settingsHost = hosts?.settings ?? null;

  return (
    <>
      <div
        ref={rootRef}
        data-lalala-presence=""
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
          upload={props.upload}
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
      {micHost !== null && props.onMute
        ? createPortal(
            <button
              type="button"
              data-lalala-mic=""
              aria-hidden={!props.live}
              tabIndex={props.live ? undefined : -1}
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
      {settingsHost !== null ? <VoiceSettings tabHost={settingsHost} /> : null}
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
