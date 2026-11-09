// Standalone: startTurn goes to the dev server's T3 bridge, which dispatches it to T3 Code (on
// lalala.talk, the harness adapter sends it from the tab).
import { REQUEST_TIMEOUT_MS } from "../voice/voiceErrors";

type Result = { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly error: Error };

export function useOrchestrationCommand(_command: unknown, _options?: unknown) {
  return async ({ input }: { readonly environmentId: string; readonly input: unknown }): Promise<Result> => {
    try {
      const harness = globalThis.__lalalaAdapters?.harness;
      if (harness) {
        await harness.send(input);
        return { _tag: "Success" };
      }
      const body = JSON.stringify(input);
      const response = await fetch("/__lalala/t3/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // A phone between networks queues it on a dead connection forever; VoiceHost retries it.
        // Pictures ride inside as data URLs and take longer.
        signal: AbortSignal.timeout(body.length > 100_000 ? 30_000 : REQUEST_TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { _tag: "Failure", error: new Error(answer.error ?? `send answered ${response.status}`) };
      return { _tag: "Success" };
    } catch (cause) {
      return { _tag: "Failure", error: cause instanceof Error ? cause : new Error(String(cause)) };
    }
  };
}
