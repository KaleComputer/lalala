/**
 * The T3 thread that made or last updated each card, by card id: its header opens that thread in
 * T3 Code. A thread that makes or refills a card adds its own thread id: lalala's cards here, the
 * user's through `addCardThreads` (in their cards folder).
 */
export const cardThreads: Record<string, string> = {};

export function addCardThreads(more: Readonly<Record<string, string>>) {
  Object.assign(cardThreads, more);
}
