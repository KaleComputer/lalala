// ?bench=<model> on either host (src/main.tsx): a speed benchmark of one of Kale's voices through the
// same Transformers.js worker lalala speaks with (kaleVoice.worker), on the line set in lines.json
// (short replies to paragraphs, numbers, tech terms). Each line is spoken sentence by sentence, as
// lalala's player does: first audio is its first sentence, × real time its whole audio over its time.
// One model per page load, loaded once and reused for every run: a second copy in a tab is what ended
// Tim's iPhone tab (15 Nov). The runtime fixes threads and backend when it starts, so ?threads=2 and
// ?gpu are their own page loads. ?runs=3 (default), ?device=mac-chrome names the device for the
// results; ?auto starts without a tap. Silent unless play is tapped. Every line goes to the session
// log (the app) as it ends; scripts/bench-collect.mjs makes the per-device JSON from it.
import LINE_SET from "./lines.json";

type Line = { readonly id: string; readonly bucket: string; readonly text: string };
const LINES: ReadonlyArray<Line> = LINE_SET.lines;
const BUCKETS = ["short", "medium", "long", "paragraph"] as const;
const QUERY = new URLSearchParams(location.search);
/**
 * ?bench=suite: Tim's one link (16 Nov). The 10-voice nano, then the 10-voice tiny (Ettin text side),
 * each through onnxruntime-web directly and through Transformers.js, all on the CPU (WebGPU ended his
 * iPhone tab). One step per page load (the page moves itself on), so the tab unloads one model before
 * the next. A step that ends the tab is seen on the next load (still "running" in this browser's
 * storage), reported, and skipped; errors are caught.
 */
const SUITE = QUERY.get("bench") === "suite";
const SUITE_STEPS = [
  { bench: "nano10", backend: "wasm", runtime: "direct" },
  { bench: "nano10", backend: "wasm", runtime: "transformers" },
  { bench: "tiny10", backend: "wasm", runtime: "direct" },
  { bench: "tiny10", backend: "wasm", runtime: "transformers" },
] as const;
const STEP = Math.min(SUITE_STEPS.length - 1, Math.max(0, Number(QUERY.get("step")) || 0));
/** On the CPU: onnxruntime-web's plain wasm build directly (lalala's phone path), or Transformers.js. */
const RUNTIME: "direct" | "transformers" = SUITE
  ? SUITE_STEPS[STEP].runtime
  : QUERY.get("runtime") === "transformers"
    ? "transformers"
    : "direct";
const runtimeName = (runtime: string) => (runtime === "transformers" ? "Transformers.js" : "onnxruntime-web");
const SUITE_KEY = "lalala:bench-suite";
type SuiteResult = {
  readonly step: number;
  status: "running" | "done" | "failed" | "crashed";
  firstP50?: number | null;
  xrtP50?: number | null;
  loadMs?: number;
  peakMB?: number | null;
  message?: string;
};
const suiteState = (): SuiteResult[] => {
  try {
    return JSON.parse(localStorage.getItem(SUITE_KEY) ?? "[]") as SuiteResult[];
  } catch {
    return [];
  }
};
const saveSuite = (results: SuiteResult[]) => {
  try {
    localStorage.setItem(SUITE_KEY, JSON.stringify(results));
  } catch {
    // No storage: the suite still runs, without crash memory.
  }
};
const RUNS = Math.max(1, Math.min(10, Number(QUERY.get("runs")) || (SUITE ? 1 : 3)));
const WARMUP = ["Hi there.", "The build is green, and the tests pass."];
const SITE = import.meta.env.LALALA_HOST === "site";
const RATE = 24_000;

// ?bench=nano or tiny (the model card's two), storyteller or k10c (Hazel), each in its first voice.
const BENCH_MODELS = {
  nano: { label: "kale-tts-1-nano", model: "kale-tts-1-nano", voice: "v7" },
  tiny: { label: "kale-tts-1-tiny", model: "kale-tts-1-tiny", voice: "v7" },
  nano10: { label: "kale-tts-1-nano · 10 voices", model: "kale-tts-1-nano-10", voice: "s057b" },
  tiny10: { label: "kale-tts-1-tiny · 10 voices (Ettin)", model: "kale-tts-1-tiny-10", voice: "s057b" },
  storyteller: { label: "storyteller", model: "kale-storyteller", voice: "storyteller" },
  k10c: { label: "k10c (Hazel)", model: "k10c", voice: "hazel" },
};
const MODEL = SUITE
  ? BENCH_MODELS[SUITE_STEPS[STEP].bench]
  : (BENCH_MODELS[(QUERY.get("bench") ?? "") as keyof typeof BENCH_MODELS] ?? BENCH_MODELS.nano);
const BACKEND: "wasm" | "webgpu" = SUITE
  ? SUITE_STEPS[STEP].backend
  : QUERY.has("gpu")
    ? "webgpu"
    : "wasm";
// WebGPU's default buffer cache kept every sentence length's buffers: WebKit's GPU process reached
// 2.4 GB on the Mac for nano (563 MB with lazyRelease, same speed). ?cache= picks another mode.
const GPU_CACHE = QUERY.get("cache") ?? "lazyRelease";
const THREADS = Number(QUERY.get("threads")) || Math.min(4, navigator.hardwareConcurrency || 4);
const BENCH_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** The sentences lalala's player would send one at a time. */
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * (at - low);
};
const round = (value: number | null, places = 0) =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

type LineRun = {
  readonly run: number;
  readonly id: string;
  readonly bucket: string;
  readonly chars: number;
  readonly sentences: number;
  readonly audioS: number;
  readonly firstMs: number;
  readonly totalMs: number;
  readonly xrt: number;
};

/**
 * p50 / p90 / min for a group of line runs. First audio's p90 is its slow end; × real time's "p90"
 * is the slow end too (the value 90 % of lines beat), so both read as "worst but typical".
 */
function summarize(runs: ReadonlyArray<LineRun>) {
  const first = runs.map((run) => run.firstMs);
  const xrt = runs.map((run) => run.xrt);
  return {
    n: runs.length,
    firstP50: round(quantile(first, 0.5)),
    firstP90: round(quantile(first, 0.9)),
    firstMin: round(quantile(first, 0)),
    xrtP50: round(quantile(xrt, 0.5), 1),
    xrtP90: round(quantile(xrt, 0.1), 1),
    xrtMin: round(quantile(xrt, 0), 1),
  };
}

const css = `
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --line: #292524; --accent: #60a5fa; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p { margin: 6px 0; color: var(--muted); }
button { font: inherit; border: 0; border-radius: 10px; padding: 12px 18px; background: var(--accent); color: white; }
button:disabled { opacity: 0.5; }
button.small { padding: 6px 10px; font-size: 13px; background: transparent; color: var(--accent); border: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; margin: 16px 0; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 500; }
#status { margin: 12px 0; min-height: 1.4em; }
.note { color: #b45309; }
`;

document.title = "lalala · voice bench";
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
(window as Window & { __lalalaBootDone?: () => void }).__lalalaBootDone?.();
const root = document.getElementById("root")!;
root.innerHTML = `<main>
  <h1>${SUITE ? `Speed suite · step ${STEP + 1} of ${SUITE_STEPS.length}: ` : ""}${MODEL.label} speed on this device</h1>
  <p>${BACKEND === "webgpu" ? "WebGPU" : `CPU, ${THREADS} threads, ${runtimeName(RUNTIME)}`}. Loads the model once, warms up, then speaks ${LINES.length} lines (short replies to paragraphs) ${RUNS} times, sentence by sentence as lalala does. Nothing plays unless you tap play. A few minutes; keep this page in front.</p>
  <button id="run">Run</button>
  <div id="status"></div>
  <table><thead><tr><th>lines</th><th>first audio p50 · p90 · min</th><th>× real time p50 · p90 · min</th></tr></thead><tbody id="rows"></tbody></table>
  <p id="meta"></p>
  <p id="saved"></p>
  <button id="copy" class="small" hidden>Copy results</button>
  <button id="play" class="small" hidden>Play the last line</button>
</main>`;
const $ = (id: string) => document.getElementById(id)!;

let log: ((type: string, data: Record<string, unknown>) => void) | null = null;
async function logger() {
  if (SITE) return null;
  const { voiceLog } = await import("../voice/voiceLog");
  return (type: string, data: Record<string, unknown>) =>
    voiceLog("system", type, { bench: BENCH_ID, ...data });
}

/** What the browser says about the device: Chrome's client hints where it has them, else the user agent. */
async function deviceInfo() {
  type Hints = { getHighEntropyValues(keys: string[]): Promise<Record<string, unknown>> };
  const data = (navigator as Navigator & { userAgentData?: Hints }).userAgentData;
  const hints = await data
    ?.getHighEntropyValues(["model", "platform", "platformVersion", "architecture", "fullVersionList"])
    .catch(() => null);
  const browsers = Array.isArray(hints?.fullVersionList)
    ? (hints.fullVersionList as { brand: string; version: string }[])
        .filter((entry) => !/Not.?A.?Brand/i.test(entry.brand))
        .map((entry) => `${entry.brand} ${entry.version}`)
        .join(", ")
    : null;
  return {
    device: QUERY.get("device") && BACKEND === "webgpu" && !QUERY.get("device")!.includes("webgpu")
      ? `${QUERY.get("device")}-webgpu`
      : QUERY.get("device"),
    ua: navigator.userAgent,
    hintModel: (hints?.model as string) || null,
    hintPlatform: hints ? `${hints.platform} ${hints.platformVersion}` : null,
    hintArch: (hints?.architecture as string) ?? null,
    browsers,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    isolated: self.crossOriginIsolated,
  };
}

/**
 * The page's memory with its workers, where the browser measures it: Chrome's
 * measureUserAgentSpecificMemory (cross-origin isolated pages), else Chrome's JS heap of this page
 * alone, else nothing (Safari exposes neither).
 */
async function memory(): Promise<{ bytes: number | null; method: string }> {
  const perf = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  if (self.crossOriginIsolated && perf.measureUserAgentSpecificMemory) {
    const measured = await perf.measureUserAgentSpecificMemory().catch(() => null);
    if (measured) return { bytes: measured.bytes, method: "measureUserAgentSpecificMemory" };
  }
  if (perf.memory) return { bytes: perf.memory.usedJSHeapSize, method: "performance.memory (page heap only)" };
  return { bytes: null, method: "not exposed by this browser" };
}

let audioContext: AudioContext | null = null;
function play(samples: Float32Array<ArrayBuffer>) {
  audioContext ??= new AudioContext();
  const buffer = audioContext.createBuffer(1, samples.length, RATE);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
}

function voiceWorker() {
  const worker = new Worker(new URL("../voice/browserSpeech/kaleVoice.worker.ts", import.meta.url), {
    type: "module",
  });
  const waiting = new Map<number, (data: { samples?: Float32Array<ArrayBuffer>; message?: string }) => void>();
  let settle: (error: string | null) => void = () => {};
  const ready = new Promise<string | null>((resolve) => (settle = resolve));
  const info: Record<string, unknown> = { cached: false };
  worker.onmessage = ({ data }) => {
    if (data.type === "load") info.cached = data.cached;
    else if (data.type === "stage" && data.stage === "backend") {
      info.threads = data.threads;
      info.ort = data.ort;
      info.transformers = data.transformers;
    } else if (data.type === "ready") settle(null);
    else if (data.type === "failed") settle(data.message);
    else if (data.type === "audio" || data.type === "error") waiting.get(data.id)?.(data);
  };
  worker.onerror = (event) => settle(event.message || "worker error");
  let nextId = 1;
  const speak = (text: string) =>
    new Promise<Float32Array<ArrayBuffer>>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (data) => {
        waiting.delete(id);
        if (data.samples) resolve(data.samples);
        else reject(new Error(data.message));
      });
      worker.postMessage({ type: "speak", id, text });
    });
  return { worker, ready, info, speak };
}

async function start() {
  const button = $("run") as HTMLButtonElement;
  button.disabled = true;
  log = await logger();
  const device = await deviceInfo();
  const voice = voiceWorker();
  const status = (text: string) => ($("status").textContent = text);
  const peak = { bytes: null as number | null, method: "not exposed by this browser" };
  const sample = async () => {
    const now = await memory();
    peak.method = now.method;
    if (now.bytes !== null) peak.bytes = Math.max(peak.bytes ?? 0, now.bytes);
  };
  const base = {
    model: MODEL.model,
    voice: MODEL.voice,
    backend: BACKEND,
    runtime: RUNTIME,
    runs: RUNS,
    lines: LINES.length,
    lineSet: `src/bench/lines.json v${LINE_SET.version}`,
  };
  let lastAudio: Float32Array<ArrayBuffer> | null = null;
  try {
    status("Loading the model…");
    const loadStarted = performance.now();
    // WebGPU runs log every step on the way, so a tab the browser kills still shows where it died.
    if (BACKEND === "webgpu") await log?.("bench.trace", { step: "page", ...device, model: MODEL.model, backend: BACKEND });
    voice.worker.postMessage({
      type: "load",
      device: BACKEND,
      model: MODEL.model,
      voice: MODEL.voice,
      threads: THREADS,
      runtime: RUNTIME,
      ...(BACKEND === "webgpu" ? { trace: BENCH_ID, gpuCache: GPU_CACHE } : {}),
    });
    const error = await voice.ready;
    if (error !== null) throw new Error(error);
    const loadMs = Math.round(performance.now() - loadStarted);
    await sample();
    log?.("bench.start", { ...base, ...device, ...voice.info, loadMs });
    status("Warming up…");
    for (const text of WARMUP) await voice.speak(text);
    const results: LineRun[] = [];
    for (let run = 1; run <= RUNS; run++) {
      for (const [at, line] of LINES.entries()) {
        status(`Run ${run} of ${RUNS} · line ${at + 1} of ${LINES.length}`);
        const sentences = sentencesOf(line.text);
        const started = performance.now();
        let firstMs = 0;
        let samples = 0;
        const parts: Float32Array<ArrayBuffer>[] = [];
        for (const sentence of sentences) {
          const audio = await voice.speak(sentence);
          if (firstMs === 0) firstMs = performance.now() - started;
          samples += audio.length;
          if (run === RUNS && at === LINES.length - 1) parts.push(audio);
        }
        const totalMs = performance.now() - started;
        const audioS = samples / RATE;
        const result: LineRun = {
          run,
          id: line.id,
          bucket: line.bucket,
          chars: line.text.length,
          sentences: sentences.length,
          audioS: Math.round(audioS * 1000) / 1000,
          firstMs: Math.round(firstMs),
          totalMs: Math.round(totalMs),
          xrt: Math.round((audioS / (totalMs / 1000)) * 100) / 100,
        };
        results.push(result);
        log?.("bench.line", result);
        if (parts.length > 0) {
          const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
          let offset = 0;
          for (const part of parts) {
            joined.set(part, offset);
            offset += part.length;
          }
          lastAudio = joined;
        }
      }
      await sample();
    }
    const summary = {
      ...base,
      loadMs,
      cold: !voice.info.cached,
      peakMemoryBytes: peak.bytes,
      memoryMethod: peak.method,
      all: summarize(results),
      ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, summarize(results.filter((run) => run.bucket === bucket))])),
    };
    log?.("bench.done", { ...summary, all: undefined, ...flat("all", summary.all), ...Object.assign({}, ...BUCKETS.map((bucket) => flat(bucket, summary[bucket]))) });
    showSummary(summary, device, voice.info);
    status("Done.");
    suiteStepEnded({
      status: "done",
      firstP50: summary.all.firstP50,
      xrtP50: summary.all.xrtP50,
      loadMs,
      peakMB: peak.bytes === null ? null : Math.round(peak.bytes / 1e6),
    });
    const report = { at: new Date().toISOString(), device, runtime: voice.info, summary, lines: results };
    $("saved").textContent = await save(report).catch((cause: unknown) => `Couldn't save: ${String(cause)}`);
    const copy = $("copy") as HTMLButtonElement;
    copy.hidden = false;
    copy.onclick = () => void navigator.clipboard.writeText(JSON.stringify(report)).then(() => (copy.textContent = "Copied"));
    (window as Window & { __benchReport?: unknown }).__benchReport = report;
  } catch (error) {
    status(`Didn't finish: ${String(error)}`);
    log?.("bench.failed", { ...base, message: String(error) });
    suiteStepEnded({ status: "failed", message: String(error).slice(0, 200) });
  } finally {
    voice.worker.terminate();
  }
  if (lastAudio) {
    const audio = lastAudio;
    const playButton = $("play") as HTMLButtonElement;
    playButton.hidden = false;
    playButton.onclick = () => play(audio);
  }
  // Again in a fresh page, never a second copy of the model in this one.
  button.disabled = false;
  button.textContent = "Run again";
  button.onclick = () => {
    const again = new URL(location.href);
    again.searchParams.set("auto", "");
    location.assign(again);
  };
}

/** A summary group as top-level keys: the session log keeps objects only a few levels deep. */
const flat = (prefix: string, group: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(group).map(([key, value]) => [`${prefix}_${key}`, value]));

function showSummary(
  summary: Record<string, unknown> & { all: ReturnType<typeof summarize> },
  device: Awaited<ReturnType<typeof deviceInfo>>,
  runtime: Record<string, unknown>,
) {
  const ms = (value: number | null) => (value === null ? "–" : `${(value / 1000).toFixed(2)} s`);
  const x = (value: number | null) => (value === null ? "–" : `${value}×`);
  const rows = [["all lines", summary.all], ...BUCKETS.map((bucket) => [bucket, summary[bucket]])] as [
    string,
    ReturnType<typeof summarize>,
  ][];
  for (const [name, group] of rows) {
    const row = document.createElement("tr");
    for (const text of [
      `${name} (${group.n})`,
      `${ms(group.firstP50)} · ${ms(group.firstP90)} · ${ms(group.firstMin)}`,
      `${x(group.xrtP50)} · ${x(group.xrtP90)} · ${x(group.xrtMin)}`,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    $("rows").append(row);
  }
  const memoryText =
    summary.peakMemoryBytes === null
      ? `memory: ${summary.memoryMethod}`
      : `peak memory ${Math.round((summary.peakMemoryBytes as number) / 1e6)} MB (${summary.memoryMethod})`;
  $("meta").textContent = `load ${ms(summary.loadMs as number)}${summary.cold ? " incl. download" : ""} · ${memoryText} · ${runtime.threads ?? "?"} threads · onnxruntime-web ${runtime.ort ?? "?"} · Transformers.js ${runtime.transformers ?? "?"} · ${device.cores ?? "?"} cores`;
}

async function save(report: Record<string, unknown>) {
  if (!SITE) return "Saved to the session log on your computer.";
  const { browserBrain, browserHarness } = await import("../voice/adapters/harness/browser");
  if (!browserBrain()) return "Not paired with your computer here: tap Copy results and send them.";
  const harness = browserHarness();
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  await harness.writeFile!(".lalala/bench/.gitignore", "*\n");
  await harness.writeFile!(`.lalala/bench/${MODEL.model}-${stamp}.json`, JSON.stringify(report, null, 2));
  return "Saved to your computer (.lalala/bench).";
}

/** The suite's step is over: note it, then the next step in a fresh page, or the table at the end. */
function suiteStepEnded(result: Omit<SuiteResult, "step">) {
  if (!SUITE) return;
  const results = suiteState().filter((entry) => entry.step !== STEP);
  results.push({ step: STEP, ...result });
  saveSuite(results);
  nextSuiteStep(results);
}
function nextSuiteStep(results: SuiteResult[]) {
  if (STEP + 1 < SUITE_STEPS.length) {
    const next = new URL(location.href);
    next.searchParams.set("step", String(STEP + 1));
    next.searchParams.set("auto", "");
    window.setTimeout(() => location.replace(next), 1500);
    return;
  }
  showSuite(results);
}
function showSuite(results: SuiteResult[]) {
  log?.("bench.suite", Object.fromEntries(results.flatMap((entry) => {
    const name = `${SUITE_STEPS[entry.step]?.bench}_${SUITE_STEPS[entry.step]?.runtime}`;
    return [[`${name}_status`, entry.status], [`${name}_xrt`, entry.xrtP50 ?? null], [`${name}_first`, entry.firstP50 ?? null], [`${name}_loadMs`, entry.loadMs ?? null], [`${name}_peakMB`, entry.peakMB ?? null], [`${name}_message`, entry.message ?? null]];
  })));
  const table = results
    .toSorted((a, b) => a.step - b.step)
    .map((entry) => {
      const step = SUITE_STEPS[entry.step]!;
      const what = `${BENCH_MODELS[step.bench].label} · ${runtimeName(step.runtime)}`;
      const memoryText = entry.peakMB == null ? "" : `, ${entry.peakMB} MB`;
      const result =
        entry.status === "done"
          ? `${entry.xrtP50}× real time, first audio ${((entry.firstP50 ?? 0) / 1000).toFixed(2)} s, load ${((entry.loadMs ?? 0) / 1000).toFixed(1)} s${memoryText}`
          : entry.status === "crashed"
            ? "the tab died here (the Mac log has the last step)"
            : `error: ${entry.message}`;
      return `<tr><td>${what}</td><td colspan="2">${result}</td></tr>`;
    })
    .join("");
  $("rows").innerHTML = table;
  $("status").textContent = "Suite done.";
}

$("run").onclick = () => {
  if (SUITE) {
    saveSuite([]);
    const first = new URL(location.href);
    first.searchParams.set("step", "0");
    first.searchParams.set("auto", "");
    location.replace(first);
    return;
  }
  void start();
};
if (SUITE && QUERY.has("auto")) {
  const results = suiteState();
  const mine = results.find((entry) => entry.step === STEP);
  if (mine?.status === "running") {
    // This step ended the tab last time: say so and go on.
    mine.status = "crashed";
    saveSuite(results);
    void logger().then((write) => {
      write?.("bench.crashed", { suiteStep: STEP, model: MODEL.model, backend: BACKEND, runtime: RUNTIME });
      nextSuiteStep(results);
    });
  } else if (mine) {
    nextSuiteStep(results);
  } else {
    results.push({ step: STEP, status: "running" });
    saveSuite(results);
    void start();
  }
} else if (QUERY.has("auto")) void start();
