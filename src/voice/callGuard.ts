import { speechLoading } from "./browserSpeech/browser";
import { keepHmrAcrossDisconnects, pingViteServer } from "./hmrReconnect";
import { type HmrHotLike, installHmrCallGuard } from "./liveUpdate";
import { isCallLive, markUpdateReady } from "./phoneUpdate";
import { voiceLog } from "./voiceLog";

/**
 * The call runs whenever VoiceHost reports a live call, a speech model is still downloading or
 * loading, or any mounted device bar is out of standby ("off") / marked live.
 */
function callActive(): boolean {
  if (isCallLive() || speechLoading()) return true;
  for (const bar of document.querySelectorAll<HTMLElement>("[data-lalala-presence]")) {
    if (bar.hasAttribute("data-lalala-live") || (bar.dataset.voiceState ?? "off") !== "off") {
      return true;
    }
  }
  return false;
}

/** Reloading is only safe with the call off and nothing typed in a field. */
export function voiceIdle(): boolean {
  const active = document.activeElement;
  // The composer is focused on load; only a field with text in it means someone is typing.
  const typing =
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.value
      : active instanceof HTMLElement && active.isContentEditable
        ? active.textContent
        : ""
    )?.trim() !== "";
  return !callActive() && !typing;
}

function clearErrorOverlays(): void {
  for (const overlay of document.querySelectorAll("vite-error-overlay")) {
    const closable = overlay as HTMLElement & { close?: () => void };
    if (typeof closable.close === "function") closable.close();
    else overlay.remove();
  }
}

async function waitForServer(socketUrl?: string): Promise<void> {
  if (!socketUrl) return;
  const url = new URL(socketUrl);
  url.search = "";
  for (;;) {
    if (await pingViteServer(url.href)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
}

declare global {
  /** Where the app serves the user's cards folder (vite/cards.mjs); they hot-update like extras/. */
  var __lalalaCardsUrl: string | undefined;
}

// Dev: a hot update outside extras/ remounts the voice host and a dev server restart reloads the
// page, either one ends the call. During a call extras and CSS still apply; the rest is held for
// one reload once the call is off (Vite awaits these listeners before it applies anything).
if (import.meta.hot) {
  const hot = import.meta.hot;
  installHmrCallGuard({
    hot: hot as unknown as HmrHotLike,
    callActive,
    voiceIdle,
    cardsUrl: () => globalThis.__lalalaCardsUrl,
    pathname: () => location.pathname,
    clearErrorOverlays,
    waitForServer,
    onHold: (what) => {
      voiceLog("system", "update.held", { what });
      // The bar's update chip: tapping it reloads now instead of after the call.
      markUpdateReady();
    },
    onReload: (why) => {
      voiceLog("system", "reload", { why });
      window.location.reload();
    },
    keepAcrossDisconnects: (guard) => keepHmrAcrossDisconnects(hot, guard),
  });
}
