import type { SharedDoc, StorageAdapter } from "../index";

// The app's server keeps one copy for every device (vite/canvasLayout.ts, vite/t3bridge.mjs).
const ROUTES: Record<SharedDoc, { readonly url: string; readonly method: string }> = {
  canvas: { url: "/__lalala/canvas", method: "POST" },
  settings: { url: "/__lalala/t3/settings", method: "PUT" },
};

const answer = (response: Response) => (response.ok ? response.json() : null);

export const serverStorage: StorageAdapter = {
  shared: true,
  read: (doc) =>
    fetch(ROUTES[doc].url, { cache: "no-store", signal: AbortSignal.timeout(3_000) }).then(answer),
  write: (doc, body, options) =>
    fetch(ROUTES[doc].url, {
      method: ROUTES[doc].method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: options?.leaving ?? false,
    }).then(answer),
};
