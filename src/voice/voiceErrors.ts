/**
 * What the bar may say when something fails. Our own messages pass through; the browser's raw errors
 * never do (Safari's "The string did not match the expected pattern." is its JSON parse error for an
 * empty 502 while lalala restarts, "Load failed" a fetch that never reached it).
 */

export const UNREACHABLE_TEXT = "Lost the connection to lalala. Reconnecting…";
/** The link is down (voiceLink): the user's words wait in the outbox until it is back. */
export const OFFLINE_TEXT = "Offline. Holding your words until the connection is back.";
/** The outbox gave up on the user's words while lalala answered; a tap sends them again. */
export const NOT_SENT_TEXT = "Your words weren't sent.";
/** How long a plain request to lalala may go unanswered: a phone between networks queues it forever. */
export const REQUEST_TIMEOUT_MS = 8_000;
const UNKNOWN_TEXT = "Something went wrong in the call; the voice log has the details.";

/** Lalala didn't answer, or answered with something unreadable: a restart or a dropped network. */
export class VoiceUnreachable extends Error {
  constructor() {
    super(UNREACHABLE_TEXT);
    this.name = "VoiceUnreachable";
  }
}

/** A 502/503/504 is lalala (or its phone front door) without a server behind it. */
export const isGatewayStatus = (status: number) =>
  status === 502 || status === 503 || status === 504;

/** The response's JSON body; `{}` when it has none or it isn't JSON (never the browser's parse error). */
export async function readJson<T extends object>(response: Response): Promise<Partial<T>> {
  try {
    const value: unknown = JSON.parse(await response.text());
    return typeof value === "object" && value !== null ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** Words for the bar: our own and the server's messages as they are; what the browser itself threw
    (a TypeError, SyntaxError or DOMException) never. */
export function voiceErrorText(cause: unknown): string {
  if (cause instanceof VoiceUnreachable) return cause.message;
  if (cause instanceof DOMException || cause instanceof TypeError || cause instanceof SyntaxError)
    return UNKNOWN_TEXT;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string" && cause !== "") return cause;
  return UNKNOWN_TEXT;
}

/** What the bar shows for an error: a short tag, an optional hint, and the plain sentence a reader hears. */
export type ErrorTag = { readonly tag: string; readonly hint: string | null; readonly said: string };

/**
 * The bar's words for an error message: a few plain words on its tag beside the glitch, never the raw
 * message (it may name a script or a host; the voice log keeps it) and never a command to run. Out of a
 * call a tap starts it again; in a call the next words try again on their own.
 */
export function errorTag(message: string, live: boolean): ErrorTag {
  const retry = live ? "Retrying" : "Tap to retry";
  const again = live ? " It tries again on its own." : " Tap to try again.";
  if (message === NOT_SENT_TEXT)
    return {
      tag: "Words not sent",
      hint: "Tap to retry",
      said: "Your last words weren't sent. Tap to send them again.",
    };
  if (/timed out|socket closed|didn.t answer/i.test(message))
    return {
      tag: "Speech didn't answer",
      hint: retry,
      said: `The speech service didn't answer in time.${again}`,
    };
  if (/local speech|speech down|models?\b.*\b(load|fail)|speech\.sh|npm run speech/i.test(message))
    return {
      tag: "Voice models didn't load",
      hint: retry,
      said: `The voice models didn't load.${again}`,
    };
  if (/microphone|\bmic\b|notallowed|permission/i.test(message))
    return {
      tag: "Mic blocked",
      hint: "Allow it in the browser",
      said: "The browser blocked the microphone. Allow it in the browser's site settings.",
    };
  if (/default model/i.test(message))
    return { tag: "No model picked", hint: "Pick one in settings", said: message };
  if (/elevenlabs/i.test(message))
    return { tag: "ElevenLabs not set up", hint: null, said: "ElevenLabs isn't set up here." };
  if (/project/i.test(message))
    return { tag: "No voice project", hint: null, said: "There is no voice project here yet." };
  return { tag: "No signal", hint: retry, said: `Something went wrong in the call.${again}` };
}
