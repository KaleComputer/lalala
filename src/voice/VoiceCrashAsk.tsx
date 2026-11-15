import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  TINY_VOICE,
  WARM_VOICE,
  replyVoice,
  retryTinyVoice,
  setReplyVoice,
  subscribeSettings,
  tinyCrashed,
} from "./settingsStore";
import { voiceLog } from "./voiceLog";
import "./voiceSecret.css";

const asking = () => tinyCrashed() && replyVoice() === TINY_VOICE;

/**
 * kale-tts-1-tiny took this tab down last time (browser.ts marks it): the bar says so and asks what
 * should speak, suggesting the next voice. Nothing switches or loads until a pick answers it.
 */
export function VoiceCrashAsk(props: { readonly host: HTMLElement }) {
  const open = useSyncExternalStore(subscribeSettings, asking, () => false);
  if (!open) return null;
  const pick = (choice: "warm" | "again") => {
    voiceLog("system", "speech.crash-answer", { choice });
    if (choice === "warm") setReplyVoice(WARM_VOICE);
    else retryTinyVoice();
  };
  return createPortal(
    <div data-lalala-secret-panel="">
      <div data-lalala-secret="" role="alertdialog" aria-label="The voice crashed">
        <p data-lalala-secret-ask="">
          <b>The voice crashed</b>
          <span>kale-tts-1-tiny</span>
        </p>
        <p data-lalala-secret-reason="">
          kale-tts-1-tiny took this tab down last time, so nothing speaks yet. What should?
        </p>
        <div data-lalala-crash-choices="">
          <button type="button" data-suggested="" onClick={() => pick("warm")}>
            Try warm Kokoro
          </button>
          <button type="button" onClick={() => pick("again")}>
            Try kale-tts-1-tiny again
          </button>
        </div>
      </div>
    </div>,
    props.host,
  );
}
