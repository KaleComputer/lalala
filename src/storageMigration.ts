// This page's settings from before the rename (t3voice:*, same origin) carry over once. Imported first
// in main.tsx: the stores read their keys as their modules load.
try {
  for (const key of Object.keys(localStorage)) {
    const next = key.startsWith("t3voice:") ? `lalala:${key.slice("t3voice:".length)}` : null;
    if (next !== null && localStorage.getItem(next) === null) {
      localStorage.setItem(next, localStorage.getItem(key) ?? "");
    }
  }
} catch {
  // No storage: nothing to carry over.
}

export {};
