import { voiceLog } from "./voiceLog";

/** The call runs unless the bar is on standby ("off") or not mounted. */
function callActive(): boolean {
  const bar = document.querySelector<HTMLElement>("[data-t3voice-presence]");
  return (bar?.dataset.voiceState ?? "off") !== "off";
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

// Modules that apply their own hot update without remounting the voice host.
const LIVE = ["/src/voice/extras/", "/src/voice/extrasImages.ts", "/src/voice/voiceThemeSync.ts"];
const live = (path: string) => {
  const file = path.split("?")[0] ?? path;
  return file.endsWith(".css") || LIVE.some((prefix) => file.startsWith(prefix));
};

// Dev: a hot update outside extras/ remounts the voice host and a dev server restart reloads the
// page, either one ends the call. During a call extras and CSS still apply; the rest is held for
// one reload once the call is off (Vite awaits these listeners before it applies anything).
if (import.meta.hot) {
  let waiting: Promise<void> | null = null;
  const whenIdle = () =>
    (waiting ??= new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        if (!voiceIdle()) return;
        window.clearInterval(timer);
        resolve();
      }, 1_000);
    }));
  let held = false;
  const hold = (what: string) => {
    if (held) return;
    held = true;
    voiceLog("system", "update.held", { what });
    void whenIdle().then(() => {
      voiceLog("system", "reload", { why: "held dev update, voice off" });
      window.location.reload();
    });
  };
  import.meta.hot.on("vite:beforeUpdate", (payload) => {
    if (!callActive()) return;
    const now = payload.updates.filter((update) => live(update.path));
    if (now.length === payload.updates.length) return;
    hold(payload.updates.map((update) => update.path).join(", "));
    payload.updates.splice(0, payload.updates.length, ...now);
  });
  import.meta.hot.on("vite:beforeFullReload", (payload) => {
    if (!callActive()) return;
    hold(payload.path ?? "full reload");
    // The client reloads for an .html path only when it is this page's.
    payload.path = "/__t3voice-held.html";
  });
  // After a server restart the client pings until it is back, then reloads; that waits for idle too.
  import.meta.hot.on("vite:ws:disconnect", () => (callActive() ? whenIdle() : undefined));
}
