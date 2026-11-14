import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  useAnswerVoiceSecret,
  useVoiceSecretAsk,
  useVoiceSecretThreads,
  type VoiceSecretAnswer,
  type VoiceSecretAsk,
  type VoiceSecretThread,
} from "../state/voiceSecretRequests";
import { useSharedBrainThread } from "./brainCompaction";
import { liftOverKeyboard } from "./keyboardLift";
import { StreamerText } from "./streamerMode";
import { voiceLog } from "./voiceLog";
import "./voiceSecret.css";

/**
 * Secrets agents asked the user for (T3's `request_secret`), on the bar while they wait: the chat's card
 * shows only in its thread's view, which he never has open on the canvas. Any thread's request shows,
 * since the brain hands the asking to the thread that needs the secret (brain.md). The value goes to
 * T3 through the same call as the chat's card and is kept nowhere here: not in the log, not in storage.
 */
export function SecretAsks(props: { readonly host: HTMLElement; readonly bar: HTMLElement }) {
  const threads = useVoiceSecretThreads(useSharedBrainThread());
  if (threads.length === 0) return null;
  return createPortal(
    <div data-lalala-secret-panel="">
      {threads.map((thread) => (
        <WaitingThread key={thread.key} thread={thread} bar={props.bar} />
      ))}
    </div>,
    props.host,
  );
}

function WaitingThread(props: { readonly thread: VoiceSecretThread; readonly bar: HTMLElement }) {
  const ask = useVoiceSecretAsk(props.thread);
  if (ask === null) return null;
  return <SecretForm key={ask.turnItemId} thread={props.thread} ask={ask} bar={props.bar} />;
}

function SecretForm(props: {
  readonly thread: VoiceSecretThread;
  readonly ask: VoiceSecretAsk;
  readonly bar: HTMLElement;
}) {
  const { thread, ask } = props;
  const answer = useAnswerVoiceSecret();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Enter and a tap can both send before a render.
  const inFlight = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new request closes the bar's other panels (they share its place) and, while it waits, the phone keyboard (visual viewport) lifts the bar over itself
  useEffect(() => {
    voiceLog("system", "secret.asked", { label: ask.label });
    document.dispatchEvent(new CustomEvent("lalala:panel", { detail: "secret" }));
    return liftOverKeyboard(props.bar);
  }, [ask.label, props.bar]);

  const send = async (reply: VoiceSecretAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const failed = await answer(thread, ask, reply).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
    // Only the outcome: never the value.
    voiceLog("system", "secret.answered", { answer: reply.type, ok: failed === null });
    if (failed === null) setSecret("");
    else setProblem(failed);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (secret.trim().length > 0) void send({ type: "save", secret });
  };

  return (
    <form data-lalala-secret="" autoComplete="off" onSubmit={onSubmit}>
      <p data-lalala-secret-ask="">
        <b>{ask.label}</b>
        <span>
          <StreamerText text={thread.title} />
        </span>
      </p>
      {ask.reason.trim() ? (
        <p data-lalala-secret-reason="">
          <StreamerText text={ask.reason} />
        </p>
      ) : null}
      <div data-lalala-input-field="">
        <div>
          <input
            // A password field would offer to save it as a login; the dots come from CSS instead.
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            enterKeyHint="done"
            aria-label={`${ask.label}, asked by ${thread.title}`}
            placeholder={ask.placeholder ?? "Paste the secret"}
            value={secret}
            disabled={busy}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
          <button
            type="button"
            data-lalala-input-cell=""
            aria-label="Decline"
            disabled={busy}
            onClick={() => void send({ type: "decline" })}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <button
            type="submit"
            data-lalala-input-cell=""
            data-send=""
            aria-label="Save securely"
            disabled={busy || secret.trim().length === 0}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </button>
        </div>
      </div>
      <p data-lalala-secret-note="" data-problem={problem === null ? undefined : ""} role="status">
        {problem ??
          (ask.file
            ? "Kept out of chat, in a private file this agent's commands can read for 24 hours"
            : "Stored securely, never shown to the agent")}
      </p>
    </form>
  );
}
