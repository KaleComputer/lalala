/**
 * The T3 thread that made or last updated each card, by card id: its header opens that thread in
 * T3 Code. A thread that makes or refills a card writes its own thread id here.
 */
export const cardThreads: Readonly<Record<string, string>> = {};
