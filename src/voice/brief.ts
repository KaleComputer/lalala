import type { OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import cardsBrief from "./brain-cards.md?raw";
import filesBrief from "./brain-files.md?raw";
import brainBrief from "./brain.md?raw";
import { isFollowing } from "./follow";
import { delegatesTag } from "./settingsStore";

/**
 * How the brain makes cards depends on the host: the app loads new code under src/voice/extras/,
 * lalala.talk's prebuilt page shows the files its harness reads (brainCards.ts).
 */
const brief = () =>
  `${brainBrief}${globalThis.__lalalaAdapters?.harness?.readFile ? cardsBrief : filesBrief}`;

/**
 * The brain's instructions travel in the voice thread itself, so they must come back whenever the
 * thread could have lost them: on its first turn, after any compaction, and after they change.
 */
const briefVersion = () => {
  const text = brief();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
};

const storageKey = (threadId: ThreadId) => `lalala:brief:${threadId}`;

export function withBrief(text: string): string {
  return `${brief()}\n---\n\nThe user says: ${text}`;
}

/**
 * the user's open canvas, follow mode and the settings for new threads, for the brain:
 * `[canvas: Ideas (id c1x) · follow on · delegates: default effort=high fastMode=false]`.
 * Before it, what the brain wrote that he didn't hear, if anything (topicHold's unheardLines):
 * `[unheard: "Kokoro: done. It took ten…" · "Step two: open…"]`.
 */
export function withCanvas(text: string, unheard: ReadonlyArray<string> = []): string {
  const canvases = globalThis.__lalalaCanvases?.snapshot();
  const open = canvases?.list.find((canvas) => canvas.id === canvases.active);
  const follow = isFollowing() ? "on" : "off";
  const canvas = open ? `${open.name} (id ${open.id})` : "none";
  const missed =
    unheard.length === 0
      ? ""
      : `[unheard: ${unheard.map((line) => `"${line.replace(/[[\]]/g, "")}"`).join(" · ")}]\n`;
  return `${text}\n\n${missed}[canvas: ${canvas} · follow ${follow} · delegates: ${delegatesTag()}]`;
}

export function needsBrief(
  threadId: ThreadId,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  /** When the thread last compacted, for when its items are not loaded (no call). */
  compactedAt: number | null = null,
): boolean {
  let briefed: { version?: string; at?: number } | null = null;
  try {
    briefed = JSON.parse(localStorage.getItem(storageKey(threadId)) ?? "null");
  } catch {
    briefed = null;
  }
  if (briefed?.version !== briefVersion() || typeof briefed.at !== "number") return true;
  const since = briefed.at;
  if (compactedAt !== null && compactedAt > since) return true;
  return items.some(
    ({ item }) => item.type === "compaction" && DateTime.toEpochMillis(item.updatedAt) > since,
  );
}

export function markBriefed(threadId: ThreadId): void {
  localStorage.setItem(
    storageKey(threadId),
    JSON.stringify({ version: briefVersion(), at: Date.now() }),
  );
}
