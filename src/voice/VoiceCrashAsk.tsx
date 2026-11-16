import { Button } from "@ui-sdk/react/button";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  WARM_VOICE,
  crashedVoice,
  replyVoice,
  retryCrashedVoice,
  setReplyVoice,
  subscribeSettings,
} from "./settingsStore";
import { voiceLog } from "./voiceLog";
import "./voiceSecret.css";

const NAMES: Partial<Record<string, string>> = {
  "kale-storyteller": "The storyteller",
  "kale-tts-1-nano": "kale-tts-1-nano",
  "kale-tts-1-tiny": "kale-tts-1-tiny",
  k10c: "k10c",
  "kale-kokoro": "The warm Kokoro",
};
const asking = () => {
  const crashed = crashedVoice();
  return crashed !== null && crashed === replyVoice() ? crashed : null;
};

/**
 * A Kale voice took this tab down last time (browser.ts marks it): the bar says so and asks what
 * should speak, suggesting the next voice. Nothing switches or loads until a pick answers it.
 */
export function VoiceCrashAsk(props: { readonly host: HTMLElement }) {
  const crashed = useSyncExternalStore(subscribeSettings, asking, () => null);
  if (crashed === null) return null;
  const name = NAMES[crashed] ?? crashed;
  const pick = (choice: "warm" | "again") => {
    voiceLog("system", "speech.crash-answer", { voice: crashed, choice });
    if (choice === "warm") setReplyVoice(WARM_VOICE);
    else retryCrashedVoice();
  };
  return createPortal(
    <div data-lalala-secret-panel="">
      <div data-lalala-secret="" role="alertdialog" aria-label="The voice crashed">
        <p data-lalala-secret-ask="">
          <b>The voice crashed</b>
          <span>{crashed}</span>
        </p>
        <p data-lalala-secret-reason="">
          {name} took this tab down last time, so nothing speaks yet. What should?
        </p>
        <div data-lalala-crash-choices="">
          {crashed === WARM_VOICE ? null : (
            <Button data-suggested="" onClick={() => pick("warm")}>
              Try warm Kokoro
            </Button>
          )}
          <Button onClick={() => pick("again")}>
            Try {crashed === WARM_VOICE ? "it" : name} again
          </Button>
        </div>
      </div>
    </div>,
    props.host,
  );
}
