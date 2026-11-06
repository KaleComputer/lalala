"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  mountPresenceBar,
  type PresenceBarHosts,
  showPresenceState,
} from "../../src/voice/presenceBar";
import "../../src/voice/presence/presence.css";
import "../../src/voice/voiceBar.css";

/** The canvas's voice bar (src/voice), mounted as on /canvas, its call tabs empty until a call. */
export function Bar() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hosts, setHosts] = useState<PresenceBarHosts | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const bar = mountPresenceBar(root, {
      onPress: () => {},
      analysis: () => null,
      hearing: () => false,
    });
    if (bar === null) return;
    showPresenceState(root, bar.frame, {
      state: "off",
      label: "Start call",
      disabled: false,
      message: null,
    });
    setHosts(bar.hosts);
    return bar.dispose;
  }, []);

  return (
    <div data-lalala-dock="" data-lalala-canvas="">
      <div ref={rootRef} data-lalala-presence="" data-voice-state="off" />
      {hosts?.canvas
        ? createPortal(
            <span data-lalala-canvas-tabs="">
              <button type="button" data-lalala-canvas-name="" aria-hidden tabIndex={-1}>
                <span>lalala</span>
                <svg viewBox="0 0 8 8" aria-hidden="true">
                  <path d="M1 2.5h6L4 6.5z" />
                </svg>
              </button>
            </span>,
            hosts.canvas,
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
      {hosts?.mic
        ? createPortal(
            <button type="button" data-lalala-mic="" aria-hidden tabIndex={-1}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" />
              </svg>
            </button>,
            hosts.mic,
          )
        : null}
      {hosts?.input
        ? createPortal(
            <button type="button" data-lalala-input-tab="" data-state="closed" aria-hidden tabIndex={-1}>
              <i aria-hidden="true" />
              <b data-lalala-beam="" aria-hidden="true" />
              <svg data-lalala-input-plus="" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 1.5v9M1.5 6h9" />
              </svg>
            </button>,
            hosts.input.tab,
          )
        : null}
    </div>
  );
}
