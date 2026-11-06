import type { OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import brainBrief from "./brain.md?raw";
import { isFollowing } from "./follow";

/**
 * The brain's instructions travel in the voice thread itself, so they must come back whenever the
 * thread could have lost them: on its first turn, after any compaction, and after brain.md changes.
 */
const briefVersion = (() => {
  let hash = 0;
  for (let index = 0; index < brainBrief.length; index += 1) {
    hash = (Math.imul(hash, 31) + brainBrief.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
})();

const storageKey = (threadId: ThreadId) => `t3voice:brief:${threadId}`;

export function withBrief(text: string): string {
  return `${brainBrief}\n---\n\nThe user says: ${text}`;
}

/** The open canvas and follow mode, for the brain: `[canvas: Ideas (id c1x) · follow on]`. */
export function withCanvas(text: string): string {
  const canvases = globalThis.__t3voiceCanvases?.snapshot();
  const open = canvases?.list.find((canvas) => canvas.id === canvases.active);
  const follow = isFollowing() ? "on" : "off";
  return `${text}\n\n[canvas: ${open ? `${open.name} (id ${open.id})` : "none"} · follow ${follow}]`;
}

export function needsBrief(
  threadId: ThreadId,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): boolean {
  let briefed: { version?: string; at?: number } | null = null;
  try {
    briefed = JSON.parse(localStorage.getItem(storageKey(threadId)) ?? "null");
  } catch {
    briefed = null;
  }
  if (briefed?.version !== briefVersion || typeof briefed.at !== "number") return true;
  const since = briefed.at;
  return items.some(
    ({ item }) => item.type === "compaction" && DateTime.toEpochMillis(item.updatedAt) > since,
  );
}

export function markBriefed(threadId: ThreadId): void {
  localStorage.setItem(
    storageKey(threadId),
    JSON.stringify({ version: briefVersion, at: Date.now() }),
  );
}
