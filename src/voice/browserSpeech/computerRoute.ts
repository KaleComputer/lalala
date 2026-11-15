// How this page reaches the speech service on the computer running T3 Code.
// The lalala app: its own server forwards /__lalala/local/* to 127.0.0.1:5797 and starts the service.
// lalala.talk has no server: through the paired T3 Code it writes scripts/speech/bridge.py (with the
// service it starts) into the voice thread's project, runs it in a T3 terminal, and trades requests
// and answers with it as files (see bridge.py for the protocol).
import bridgePy from "../../../scripts/speech/bridge.py?raw";
import requirementsTxt from "../../../scripts/speech/requirements.txt?raw";
import serverPy from "../../../scripts/speech/server.py?raw";
import speechSh from "../../../scripts/speech.sh?raw";

/** "absent": this page has no way to the computer yet (lalala.talk before pairing). */
export type ComputerSpeech = "ready" | "loading" | "starting" | "off" | "down" | "absent";
export type ComputerHealth = { readonly state: ComputerSpeech; readonly reason: string | null };

export type ComputerRoute = {
  /** `start`: start the service if it isn't running ("force": even right after a failed start). */
  health(start?: "auto" | "force"): Promise<ComputerHealth>;
  stt(wav: Blob): Promise<string>;
  /** 16-bit little-endian 24 kHz PCM. */
  tts(text: string): Promise<ArrayBuffer>;
};

const DIDNT_ANSWER = "Your computer's speech service didn't answer";

const appRoute: ComputerRoute = {
  async health(start) {
    try {
      const query = start === "force" ? "?start=1" : start === "auto" ? "?start=auto" : "";
      const response = await fetch(`/__lalala/local/health${query}`, { signal: AbortSignal.timeout(4_000) });
      if (!response.headers.get("content-type")?.includes("json")) return { state: "absent", reason: null };
      if (!response.ok) return { state: "down", reason: null };
      const body = (await response.json()) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason : null;
      const state: ComputerSpeech =
        body.ready === true
          ? "ready"
          : body.starting === true
            ? "starting"
            : body.off === true
              ? "off"
              : body.down === true
                ? "down"
                : "loading";
      return { state, reason };
    } catch {
      // A dropped or slow request (a phone between networks) is no proof the route is missing.
      return { state: "down", reason: null };
    }
  },
  async stt(wav) {
    const body = (await (await appPost("/stt", { headers: { "content-type": "audio/wav" }, body: wav })).json()) as {
      text?: unknown;
    };
    return typeof body.text === "string" ? body.text : "";
  },
  async tts(text) {
    const response = await appPost("/tts", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return response.arrayBuffer();
  },
};

async function appPost(path: string, init: RequestInit): Promise<Response> {
  // A phone between networks drops the odd request ("Load failed"): one retry keeps the words.
  const send = () => fetch(`/__lalala/local${path}`, { method: "POST", signal: AbortSignal.timeout(15_000), ...init });
  const response = await send().catch(
    () => new Promise<void>((resolve) => setTimeout(resolve, 800)).then(send),
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : DIDNT_ANSWER);
  }
  return response;
}

const DIR = ".lalala/speech";
const FRESH_S = 6;
const RESTART_MS = 20_000;
const ANSWER_MS = 20_000;
let installed = false;
let retriedAt = 0;
let startedAt = 0;
// When this page first started the bridge and nothing has answered since: a start that never shows up
// (no python3, the terminal busy) is a failure to report, not "starting" forever.
let firstRunAt = 0;
const BRIDGE_SILENT_MS = 30_000;
// Detached, so the terminal's prompt is free for the next start; bridge.py lets only one run.
const BRIDGE_COMMAND = `nohup python3 ${DIR}/bridge.py >> ${DIR}/bridge.log 2>&1 &`;

const harness = () => globalThis.__lalalaAdapters?.harness;

async function install(files: NonNullable<ReturnType<typeof harness>>) {
  if (installed) return;
  await Promise.all([
    // The bridge's files change every second: never in the project's git status or T3's diffs.
    files.writeFile!(`${DIR}/.gitignore`, "*\n"),
    files.writeFile!(`${DIR}/bridge.py`, bridgePy),
    files.writeFile!(`${DIR}/scripts/speech.sh`, speechSh),
    files.writeFile!(`${DIR}/scripts/speech/server.py`, serverPy),
    files.writeFile!(`${DIR}/scripts/speech/requirements.txt`, requirementsTxt),
  ]);
  installed = true;
}

function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** One request to the bridge and its answer, read back as soon as it is there. */
async function ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const files = harness();
  if (!files?.writeFile || !files.readFile) throw new Error("Not paired with T3 Code yet");
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // The bridge's own status alongside: one that stopped (idle for 30 min) fails at once, not in 20 s.
  const [status] = await Promise.all([
    files.readFile(`${DIR}/status.json`).catch(() => null),
    files.writeFile(`${DIR}/in/${id}.json`, JSON.stringify(request)),
  ]);
  const parsed = status === null ? null : (JSON.parse(status) as { at?: unknown; state?: unknown });
  const at = Number(parsed?.at) || 0;
  if (Date.now() / 1000 - at > FRESH_S || parsed?.state === "off") {
    throw new Error(DIDNT_ANSWER);
  }
  const until = Date.now() + ANSWER_MS;
  // Each look is a round trip through T3: the first one when an answer is likely there, then sparser.
  for (let wait = 100; Date.now() < until; wait = Math.min(wait * 1.3, 300)) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const raw = await files.readFile(`${DIR}/out/${id}.json`);
    if (raw === null) continue;
    const answer = JSON.parse(raw) as Record<string, unknown>;
    if (typeof answer.error === "string") throw new Error(answer.error);
    // A long sentence's audio comes in parts (T3 reads at most 1 MiB of a file).
    const parts = typeof answer.parts === "number" ? answer.parts : 1;
    for (let index = 1; index < parts; index += 1) {
      const part = await files.readFile(`${DIR}/out/${id}.${index}.json`);
      if (part === null) throw new Error("A part of the reply's audio went missing");
      answer.pcm = `${String(answer.pcm)}${String((JSON.parse(part) as { pcm?: unknown }).pcm ?? "")}`;
    }
    return answer;
  }
  throw new Error(DIDNT_ANSWER);
}

const t3Route: ComputerRoute = {
  async health(start) {
    const files = harness();
    if (!files?.readFile || !files.writeFile || !files.run) return { state: "absent", reason: null };
    if ((await files.config().catch(() => null)) === null)
      return { state: "absent", reason: "Connect T3 Code first" };
    let status: { state?: unknown; reason?: unknown; at?: unknown } | null = null;
    try {
      const raw = await files.readFile(`${DIR}/status.json`);
      status = raw === null ? null : JSON.parse(raw);
    } catch (error) {
      return { state: "down", reason: error instanceof Error ? error.message : String(error) };
    }
    if (start) void files.writeFile(`${DIR}/wanted`, String(Date.now())).catch(() => {});
    const at = typeof status?.at === "number" ? status.at : 0;
    const live = Date.now() / 1000 - at < FRESH_S && status?.state !== "off";
    if (live) firstRunAt = 0;
    if (live) {
      const state = status!.state;
      // Retry now: the running bridge starts the service again at once.
      if (start === "force" && state === "down") {
        retriedAt = Date.now();
        await files.writeFile(`${DIR}/retry`, String(retriedAt)).catch(() => {});
        return { state: "starting", reason: null };
      }
      // Until the bridge has written a status after that retry, its old "down" is not the answer.
      if (state === "down" && at * 1000 < retriedAt) return { state: "starting", reason: null };
      return {
        state: state === "ready" || state === "loading" || state === "down" ? state : "starting",
        reason: typeof status!.reason === "string" ? status!.reason : null,
      };
    }
    if (!start) return { state: "off", reason: null };
    // Nothing answers there: write the bridge and start it in a T3 terminal (again every 20 s at most).
    if (firstRunAt !== 0 && Date.now() - firstRunAt > BRIDGE_SILENT_MS && start !== "force") {
      if (Date.now() - startedAt > RESTART_MS) {
        startedAt = Date.now();
        void install(files)
          .then(() => files.run!(BRIDGE_COMMAND))
          .catch(() => {});
      }
      return {
        state: "down",
        reason: "The bridge didn't start in T3 Code's lalala-speech terminal. Is python3 installed there?",
      };
    }
    if (start === "force" || Date.now() - startedAt > RESTART_MS) {
      startedAt = Date.now();
      if (firstRunAt === 0 || start === "force") firstRunAt = Date.now();
      try {
        await install(files);
        await files.run(BRIDGE_COMMAND);
      } catch (error) {
        return { state: "down", reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return { state: "starting", reason: null };
  },
  async stt(wav) {
    const answer = await ask({ task: "stt", wav: base64(new Uint8Array(await wav.arrayBuffer())) });
    return typeof answer.text === "string" ? answer.text : "";
  },
  async tts(text) {
    const answer = await ask({ task: "tts", text });
    const raw = atob(typeof answer.pcm === "string" ? answer.pcm : "");
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  },
};

/** lalala.talk (its harness can run commands on the paired computer) or the app's own server. */
export const computerRoute = (): ComputerRoute => (harness()?.run ? t3Route : appRoute);
/** Whether the computer is reached through T3 Code (lalala.talk) rather than this app's server. */
export const viaT3 = () => harness()?.run !== undefined;
