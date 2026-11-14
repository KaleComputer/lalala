import { useSyncExternalStore } from "react";

import { newCommandId, newMessageId, randomUUID } from "~/lib/utils";
import type { VoiceFileRef } from "./VoiceInput";

type MessageId = ReturnType<typeof newMessageId>;
type CommandId = ReturnType<typeof newCommandId>;

/**
 * the user's words on their way to the brain, oldest first. Each keeps its message and command id through
 * retries, so a resend of words T3 already took (the answer was lost) is a no-op there.
 * Words without pictures are kept in sessionStorage, so a reload while offline still sends them.
 */
export type HeldWords = {
  readonly id: string;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly at: number;
  readonly images: ReadonlyArray<File>;
  readonly files: ReadonlyArray<VoiceFileRef>;
  /** What the brain wrote that he hadn't heard when he said this (topicHold's unheardLines). */
  readonly unheard: ReadonlyArray<string>;
};

const KEY = "lalala:outbox";
const listeners = new Set<() => void>();

function load(): ReadonlyArray<HeldWords> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.flatMap((entry: Partial<HeldWords>) =>
      typeof entry?.id === "string" &&
      typeof entry.messageId === "string" &&
      typeof entry.text === "string"
        ? [
            {
              id: entry.id,
              messageId: entry.messageId as MessageId,
              commandId:
                typeof entry.commandId === "string"
                  ? (entry.commandId as CommandId)
                  : newCommandId(),
              text: entry.text,
              at: typeof entry.at === "number" ? entry.at : Date.now(),
              images: [],
              files: Array.isArray(entry.files) ? entry.files : [],
              unheard: Array.isArray(entry.unheard)
                ? entry.unheard.filter((line) => typeof line === "string")
                : [],
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

let held: ReadonlyArray<HeldWords> = typeof window === "undefined" ? [] : load();

function set(next: ReadonlyArray<HeldWords>): void {
  held = next;
  try {
    const kept = next
      .filter((words) => words.images.length === 0)
      .map(({ images: _images, ...words }) => words);
    if (kept.length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // No storage: the words stay in this page's memory.
  }
  for (const listener of listeners) listener();
}

export const heldWords = () => held;

export function holdWords(
  text: string,
  images: ReadonlyArray<File>,
  files: ReadonlyArray<VoiceFileRef>,
  unheard: ReadonlyArray<string>,
): HeldWords {
  const words = {
    id: randomUUID(),
    messageId: newMessageId(),
    commandId: newCommandId(),
    text,
    at: Date.now(),
    images,
    files,
    unheard,
  };
  set([...held, words]);
  return words;
}

export function releaseWords(id: string): void {
  set(held.filter((words) => words.id !== id));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useHeldCount(): number {
  return useSyncExternalStore(subscribe, () => held.length);
}
