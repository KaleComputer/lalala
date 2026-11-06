"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PresenceFrame } from "../../src/voice/presence/frame";
import {
  mountPresenceBar,
  type PresenceBarHosts,
  showPresenceState,
} from "../../src/voice/presenceBar";
import "../../src/voice/presence/presence.css";
import "../../src/voice/voiceBar.css";
import type { DemoView, VoiceDemo } from "./demo";

const OFF: DemoView = { state: "off", message: null };

/** The canvas's voice bar (src/voice), mounted as on /canvas; a tap starts the in-browser demo call. */
export function Bar() {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PresenceFrame | null>(null);
  const demoRef = useRef<VoiceDemo | null>(null);
  const startingRef = useRef(false);
  const [hosts, setHosts] = useState<PresenceBarHosts | null>(null);
  const [view, setView] = useState<DemoView>(OFF);
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [text, setText] = useState("");
  const live = view.state !== "off";

  const press = useEffectEvent(async () => {
    const running = demoRef.current;
    if (running !== null) {
      running.stop();
      demoRef.current = null;
      setMuted(false);
      setPhase((current) => (current === "open" ? "closing" : current));
      setView(OFF);
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    setView({ state: "connecting", message: null });
    // The demo's code and models load only now, on the tap.
    const { VoiceDemo } = await import("./demo").finally(() => (startingRef.current = false));
    const demo = new VoiceDemo((next) => {
      if (demoRef.current === demo) setView(next);
    });
    demoRef.current = demo;
    void demo.start();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts Presence's own DOM-driven frame and wave once; they live outside React
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const bar = mountPresenceBar(root, {
      onPress: () => void press(),
      analysis: () => demoRef.current?.analysis() ?? null,
      hearing: () => false,
    });
    if (bar === null) return;
    frameRef.current = bar.frame;
    setHosts(bar.hosts);
    return () => {
      demoRef.current?.stop();
      demoRef.current = null;
      frameRef.current = null;
      bar.dispose();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells Presence's frame (DOM, outside React) what the call is doing
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    showPresenceState(root, frameRef.current, {
      state: view.state,
      label: live ? "End call" : "Start call",
      disabled: false,
      message: view.message,
    });
  }, [view, live]);

  const send = () => {
    demoRef.current?.ask(text);
    setText("");
  };

  return (
    <div data-lalala-dock="" data-lalala-canvas="">
      <div ref={rootRef} data-lalala-presence="" data-voice-state={view.state} />
      {hosts?.canvas
        ? createPortal(
            <span data-lalala-canvas-tabs="">
              <button type="button" data-lalala-canvas-name="" aria-hidden={!live} tabIndex={-1}>
                <span>lalala</span>
              </button>
            </span>,
            hosts.canvas,
          )
        : null}
      {hosts?.input
        ? createPortal(
            <button
              type="button"
              data-lalala-input-tab=""
              data-open={phase === "open" ? "" : undefined}
              data-state={phase}
              aria-expanded={phase === "open"}
              aria-hidden={!live}
              tabIndex={live ? undefined : -1}
              aria-label={phase === "open" ? "Close input" : "Type to lalala"}
              onClick={() => setPhase(phase === "open" ? "closing" : "open")}
            >
              <i aria-hidden="true" />
              <b
                data-lalala-beam=""
                aria-hidden="true"
                onAnimationEnd={(event) => {
                  if (event.animationName === "lalala-beam-down")
                    setPhase((current) => (current === "closing" ? "closed" : current));
                }}
              />
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="2.5" y="5.5" width="19" height="13" rx="1.5" />
                <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M17 12.5h.01M10 12.5h4M8 15.5h8" />
              </svg>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
              </svg>
            </button>,
            hosts.input.tab,
          )
        : null}
      {hosts?.input && phase !== "closed"
        ? createPortal(
            <div data-lalala-input-panel="" data-state={phase}>
              <div data-lalala-input-field="">
                <div>
                  <textarea
                    rows={1}
                    autoFocus
                    value={text}
                    placeholder="ask lalala something"
                    aria-label="Message for lalala"
                    enterKeyHint="send"
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setPhase("closing");
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        send();
                      }
                    }}
                  />
                  <button
                    type="button"
                    data-lalala-input-cell=""
                    data-send=""
                    aria-label="Send to lalala"
                    disabled={text.trim() === ""}
                    onClick={send}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>,
            hosts.input.panel,
          )
        : null}
      {hosts?.mic
        ? createPortal(
            <button
              type="button"
              data-lalala-mic=""
              aria-hidden={!live}
              tabIndex={live ? undefined : -1}
              data-muted={muted ? "" : undefined}
              aria-pressed={muted}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              onClick={() => {
                demoRef.current?.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" />
                {muted ? <path d="M4 3l16 18" /> : null}
              </svg>
            </button>,
            hosts.mic,
          )
        : null}
      {hosts?.settings
        ? createPortal(
            <button type="button" data-lalala-settings-tab="" aria-label="Voice settings" tabIndex={-1}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>,
            hosts.settings,
          )
        : null}
    </div>
  );
}
