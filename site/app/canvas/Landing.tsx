"use client";

// First: the adapters must be in place before the canvas store loads.
import "./adapters";

import { useState } from "react";

import { CanvasCard } from "../../../src/voice/extras/CanvasCard";
import { PageLoader } from "../../../src/voice/extras/PageLoader";
import { VoiceExtras } from "../../../src/voice/extras/VoiceExtras";
import { StreamerFilter } from "../../../src/voice/streamerMode";
import {
  CanvasRows,
  openVoiceSettings,
  PAGE_ICONS,
  Row,
  Section,
  type SettingsPage,
  SoundSection,
  useCanvasValue,
  useSoundValue,
} from "../../../src/voice/VoiceSettings";
import "../../../src/voice/voicePage.css";
import "./landing.css";
import { useBrainVersion } from "./adapters";
import { Call } from "./Call";
import { ConnectSection } from "./ConnectSection";

const HIDDEN = "lalala:landing-hidden";
/** The device bar and its rail take this much of the first view's bottom (CanvasCard's BAR_ROOM). */
const BAR_ROOM = 188;

// The old /connect page sends visitors here (/?connect): the settings open at Connection.
if (new URLSearchParams(location.search).has("connect")) {
  history.replaceState(null, "", "/");
  openVoiceSettings("Connection");
}

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

/** The turning logo's card: right of the headline when the view is wide enough, else under it. */
function logoAt() {
  const talk = talkAt();
  const w = 260;
  const h = 240;
  const beside = talk.x + talk.w + 16 + w <= window.innerWidth - 12;
  return beside
    ? { x: talk.x + talk.w + 16, y: talk.y, w, h }
    : { x: Math.round((window.innerWidth - w) / 2), y: talk.y + talk.h + 16, w, h };
}

/**
 * lalala.talk: the app's own canvas (src/voice), with the page's cards on it. Visitors move, resize
 * and remove them; the layout and settings stay in this browser (the browser storage adapter).
 */
export default function Landing() {
  const [hidden, setHidden] = useState(readHidden);
  const [at] = useState(talkAt);
  const [logo] = useState(logoAt);
  const keepHidden = (next: string[]) => {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN, JSON.stringify(next));
    } catch {
      // No storage: removed for this visit only.
    }
  };
  const remove = (id: string) => () => keepHidden([...hidden, id]);
  const linked = useBrainVersion() !== 0;
  const sound = useSoundValue();
  const canvas = useCanvasValue();
  const pages: SettingsPage[] = [
    {
      id: "connection",
      title: "Connection",
      icon: PAGE_ICONS.connection,
      value: linked ? "Connected" : "Not connected",
      content: <ConnectSection />,
    },
    {
      id: "sound",
      title: "Sound & mic",
      icon: PAGE_ICONS.sound,
      value: sound,
      content: <SoundSection />,
    },
    {
      id: "canvas",
      title: "Canvas",
      icon: PAGE_ICONS.canvas,
      value: canvas,
      content: <CanvasRows />,
    },
    ...(hidden.length > 0
      ? [
          {
            id: "cards",
            title: "Cards",
            icon: PAGE_ICONS.cards,
            value: `${hidden.length} removed`,
            content: (
              <Section title="Cards">
                <Row
                  title="Removed cards"
                  description="Puts the cards you closed back on the canvas."
                >
                  <button
                    type="button"
                    data-lalala-settings-button=""
                    onClick={() => keepHidden([])}
                  >
                    Restore
                  </button>
                </Row>
              </Section>
            ),
          },
        ]
      : []),
  ];

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
            {hidden.includes("logo") ? null : (
              <CanvasCard id="logo" title="logo" at={logo} onRemove={remove("logo")}>
                <div data-landing-logo="">
                  <PageLoader play />
                </div>
              </CanvasCard>
            )}
          </VoiceExtras>
        </div>
      </main>
      <div data-lalala-dock="" data-lalala-canvas="">
        <Call settings={pages} />
      </div>
      <StreamerFilter />
    </>
  );
}
