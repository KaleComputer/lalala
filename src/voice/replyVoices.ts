/**
 * Reply voices besides Kokoro, added by the user's own cards (`cards/index.tsx` calls
 * `registerReplyVoice`), so a private voice never has to live in this repo. Each renders a whole
 * sentence in this tab; the settings list them under Sound & mic, and a voice that is gone (another
 * device, lalala.talk) falls back to Kokoro.
 */
export type ReplyVoicePlugin = {
  readonly id: string;
  readonly label: string;
  load(): Promise<Record<string, unknown>>;
  speak(
    text: string,
    signal: AbortSignal,
  ): Promise<{ readonly samples: Float32Array; readonly timing: Record<string, unknown> }>;
  unload(): void;
};

declare global {
  var __lalalaReplyVoices: Map<string, ReplyVoicePlugin> | undefined;
}

const voices = (globalThis.__lalalaReplyVoices ??= new Map<string, ReplyVoicePlugin>());
const listeners = new Set<() => void>();
let list: ReadonlyArray<ReplyVoicePlugin> = [...voices.values()];

export function registerReplyVoice(voice: ReplyVoicePlugin) {
  voices.set(voice.id, voice);
  list = [...voices.values()];
  for (const listener of listeners) listener();
}

export const replyVoicePlugin = (id: string) => voices.get(id) ?? null;
export const replyVoicePlugins = () => list;
export const subscribeReplyVoices = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
