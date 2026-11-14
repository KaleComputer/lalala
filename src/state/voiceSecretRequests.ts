// Standalone: the secret cards waiting in any thread come from the T3 bridge, and an answer posts
// to it. The bridge hands it to T3's own `secrets.answerRequest`; the value is kept nowhere here.
import { useMemo } from "react";
import { ENVIRONMENT_ID, useBridge } from "../t3/bridge";
import { REQUEST_TIMEOUT_MS } from "../voice/voiceErrors";

export interface VoiceSecretThread {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export interface VoiceSecretAsk {
  readonly turnItemId: string;
  readonly label: string;
  readonly reason: string;
  readonly placeholder: string | null;
  /** The agent's own commands can read the value (a `file` request). */
  readonly file: boolean;
}

export type VoiceSecretAnswer =
  | { readonly type: "save"; readonly secret: string }
  | { readonly type: "decline" };

const FAILED = "Could not answer the request. Try again.";

/** The bridge follows the brain's delegates itself, so the brain thread is not needed here. */
export function useVoiceSecretThreads(_brain?: unknown): ReadonlyArray<VoiceSecretThread> {
  const asks = useBridge((state) => state.asks);
  return useMemo(
    () =>
      asks.map((ask) => ({
        key: ask.turnItemId,
        environmentId: ENVIRONMENT_ID,
        threadId: ask.threadId,
        title: ask.thread,
      })),
    [asks],
  );
}

export function useVoiceSecretAsk(thread: VoiceSecretThread): VoiceSecretAsk | null {
  const asks = useBridge((state) => state.asks);
  return asks.find((ask) => ask.turnItemId === thread.key) ?? null;
}

/** Sends the user's answer. Resolves with what to tell him when it failed, or null. */
export function useAnswerVoiceSecret() {
  return async (
    thread: VoiceSecretThread,
    ask: VoiceSecretAsk,
    answer: VoiceSecretAnswer,
  ): Promise<string | null> => {
    try {
      const response = await fetch("/__lalala/t3/secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ threadId: thread.threadId, turnItemId: ask.turnItemId, answer }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return null;
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      return typeof body.error === "string" ? body.error : FAILED;
    } catch {
      return FAILED;
    }
  };
}
