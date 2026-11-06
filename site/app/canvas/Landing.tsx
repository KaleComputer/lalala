"use client";

// First: the adapters must be in place before the canvas store loads.
import "./adapters";

import { useState } from "react";

import { CanvasCard } from "../../../src/voice/extras/CanvasCard";
import { VoiceExtras } from "../../../src/voice/extras/VoiceExtras";
import { StreamerFilter } from "../../../src/voice/streamerMode";
import { VoiceBar } from "../../../src/voice/VoiceBar";
import { CanvasRows, Row, Section, SoundSection } from "../../../src/voice/VoiceSettings";
import "../../../src/voice/voicePage.css";
import "./landing.css";
import { useCall } from "./useCall";

const HIDDEN = "lalala:landing-hidden";
/** The device bar and its rail take this much of the first view's bottom (CanvasCard's BAR_ROOM). */
const BAR_ROOM = 188;

function readHidden(): string[] {
  try {
    const hidden: unknown = JSON.parse(localStorage.getItem(HIDDEN) ?? "[]");
    return Array.isArray(hidden) ? hidden.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The headline card's first place: centred in the room above the bar. */
function talkAt() {
  const w = Math.min(560, window.innerWidth - 24);
  const h = 240;
  return {
    x: Math.round((window.innerWidth - w) / 2),
    y: Math.round(Math.max(64, (window.innerHeight - BAR_ROOM - h) / 2)),
    w,
    h,
  };
}

/**
 * lalala.talk: the app's own canvas (src/voice), with the page's cards on it. Visitors move, resize
 * and remove them; the layout and settings stay in this browser (the browser storage adapter).
 */
export default function Landing() {
  const [hidden, setHidden] = useState(readHidden);
  const [at] = useState(talkAt);
  const keepHidden = (next: string[]) => {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN, JSON.stringify(next));
    } catch {
      // No storage: removed for this visit only.
    }
  };
  const remove = (id: string) => () => keepHidden([...hidden, id]);
  const call = useCall();

  return (
    <>
      <main data-lalala-page="" data-lalala-landing="">
        <div data-lalala-extras="">
          <VoiceExtras>
            {hidden.includes("talk") ? null : (
              <CanvasCard id="talk" title="lalala" at={at} onRemove={remove("talk")}>
                <div data-landing-talk="">
                  <h1>talk to all your agents</h1>
                </div>
              </CanvasCard>
            )}
          </VoiceExtras>
        </div>
      </main>
      <div data-lalala-dock="" data-lalala-canvas="">
        <VoiceBar
          {...call}
          canvasMenuAlways
          settings={
            <>
              <Section title="Connection">
                <Row
                  title="T3 Code"
                  description="Pair this page with the T3 Code on your computer to talk to your own agents."
                >
                  <a href="/connect" data-lalala-settings-button="" data-landing-link="">
                    Connect
                  </a>
                </Row>
              </Section>
              <SoundSection />
              <CanvasRows />
              {hidden.length > 0 ? (
                <Section title="Cards">
                  <Row title="Removed cards" description="Puts the cards you closed back on the canvas.">
                    <button
                      type="button"
                      data-lalala-settings-button=""
                      onClick={() => keepHidden([])}
                    >
                      Restore
                    </button>
                  </Row>
                </Section>
              ) : null}
            </>
          }
        />
      </div>
      <StreamerFilter />
    </>
  );
}
