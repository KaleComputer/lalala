/**
 * lalala's session log: events go to `/__lalala/log` (vite/sessionLog.ts) within 250 ms, text
 * only. Each event is serialised alone, batches are plain fetches retried on failure (keepalive and
 * beacons only when the page hides: iOS sent nothing else), `who`: user, voice, brain, system.
 */
export type VoiceLogWho = "user" | "voice" | "brain" | "system";

const page = Math.random().toString(36).slice(2, 10);
const FLUSH_MS = 250;
const MAX_BATCH = 20;
const MAX_QUEUE = 2_000;
let session: string | null = null;
let queue: string[] = [];
let timer: number | null = null;
let failures = 0;

function send(lines: string[], hidden: boolean): void {
  const body = `[${lines.join(",")}]`;
  if (hidden && navigator.sendBeacon?.("/__lalala/log", new Blob([body], { type: "text/plain" }))) {
    return;
  }
  void fetch("/__lalala/log", {
    method: "POST",
    // text/plain: a simple request, nothing for the browser to preflight or refuse.
    headers: { "content-type": "text/plain" },
    body,
    keepalive: hidden && body.length < 60_000,
    cache: "no-store",
  })
    .then((response) => {
      if (!response.ok) throw new Error(`log ${response.status}`);
      failures = 0;
    })
    .catch(() => {
      // Put them back in front and try again a little later (the phone may be between networks).
      failures += 1;
      queue = [...lines, ...queue].slice(-MAX_QUEUE);
      schedule(Math.min(30_000, 500 * 2 ** failures));
    });
}

function flush(hidden = false): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  while (queue.length > 0) {
    send(queue.splice(0, MAX_BATCH), hidden);
  }
}

function schedule(ms: number): void {
  timer ??= window.setTimeout(() => {
    timer = null;
    flush();
  }, ms);
}

function serialise(event: Record<string, unknown>): string {
  try {
    return JSON.stringify(event);
  } catch (error) {
    return JSON.stringify({
      t: event.t,
      page,
      session,
      who: "system",
      type: "log.unserialisable",
      of: String(event.type),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function voiceLog(who: VoiceLogWho, type: string, data: Record<string, unknown> = {}): void {
  try {
    queue.push(serialise({ t: new Date().toISOString(), page, session, who, type, ...data }));
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (failures === 0) schedule(FLUSH_MS);
  } catch {
    // Logging never breaks a call.
  }
}

/** A call starts (mic on): later events carry its id until it ends. */
export function startVoiceLogSession(data: Record<string, unknown> = {}): void {
  session = `${new Date().toISOString().slice(11, 19).replaceAll(":", "")}-${Math.random().toString(36).slice(2, 6)}`;
  voiceLog("system", "session.start", data);
  flush();
}

export function endVoiceLogSession(reason: string): void {
  voiceLog("system", "session.end", { reason });
  flush();
  session = null;
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    voiceLog("system", "page.visibility", { state: document.visibilityState });
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => {
    voiceLog("system", "page.hide");
    flush(true);
  });
  voiceLog("system", "page.load", {
    ua: navigator.userAgent.slice(0, 160),
    touch: window.matchMedia("(pointer: coarse)").matches,
  });
}
