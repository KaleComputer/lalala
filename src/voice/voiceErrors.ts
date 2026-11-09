/**
 * What the bar may say when something fails. Our own messages pass through; the browser's raw errors
 * never do (Safari's "The string did not match the expected pattern." is its JSON parse error for an
 * empty 502 while lalala restarts, "Load failed" a fetch that never reached it).
 */

export const UNREACHABLE_TEXT = "Lost the connection to lalala. Reconnecting…";
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

/** A fetch to lalala; a network failure becomes `VoiceUnreachable`. */
export async function fetchLalala(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    throw new VoiceUnreachable();
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
