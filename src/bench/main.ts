// ?bench=k10c on either host (src/main.tsx): kale-tts-1-tiny (k10c), Kale's 61 MB voice, through the
// same Transformers.js worker lalala speaks with (kaleTtsTiny.worker), on the CPU and (not on phones,
// unless ?gpu) WebGPU, each in a worker that ends after its run. Silent unless play is tapped.
// The numbers go to the session log (the app) or to .lalala/bench/ on the paired computer (lalala.talk).
const VOLCANO = [
  "A volcano is a place where very hot, melted rock comes up out of the ground.",
  "Ash and smoky gases can come out too.",
  "Deep under the ground, the melted rock waits in a big pool called a magma chamber.",
];
const RUNS = 5;
const SITE = import.meta.env.LALALA_HOST === "site";
const RATE = 24_000;

const models = { k10c: { label: "kale-tts-1-tiny" } };
// WebGPU ended Tim's iPhone tab (15 Nov): a phone runs the CPU only unless ?gpu asks.
const PHONE = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
const WITH_GPU = !PHONE || new URLSearchParams(location.search).has("gpu");
const PLAN = [
  { model: "k10c", backend: "wasm" },
  ...(WITH_GPU ? [{ model: "k10c", backend: "webgpu" }] : []),
] as const;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

type RunResult = Record<string, unknown> & { model: string; backend: string };

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
  <h1>kale-tts-1-tiny speed on this device</h1>
  <p>kale-tts-1-tiny (k10c) on the CPU${WITH_GPU ? " and on WebGPU" : ""}, ${RUNS} runs of the volcano line, median shown. Nothing plays unless you tap play. Under a minute, longer if the model still needs to download (61 MB).</p>
  <p id="gpu"></p>
  <button id="run">Run</button>
  <div id="status"></div>
  <table><thead><tr><th>model</th><th>backend</th><th>load</th><th>first sound</th><th>× real time</th><th></th></tr></thead><tbody id="rows"></tbody></table>
  <p id="saved"></p>
  <button id="copy" class="small" hidden>Copy results</button>
</main>`;
const $ = (id: string) => document.getElementById(id)!;

async function gpuInfo() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu;
  if (!gpu) return { webgpu: false, reason: "no navigator.gpu" };
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return { webgpu: false, reason: "no adapter" };
  const info = adapter.info ?? {};
  return { webgpu: true, vendor: info.vendor ?? "", architecture: info.architecture ?? "" };
}

const sec = (ms: unknown) => (typeof ms === "number" ? `${(ms / 1000).toFixed(2)} s` : "–");

let log: ((type: string, data: Record<string, unknown>) => void) | null = null;
async function logger() {
  if (SITE) return null;
  const { voiceLog } = await import("../voice/voiceLog");
  return (type: string, data: Record<string, unknown>) => voiceLog("system", type, data);
}

let audioContext: AudioContext | null = null;
function play(samples: Float32Array<ArrayBuffer>) {
  audioContext ??= new AudioContext();
  const buffer = audioContext.createBuffer(1, samples.length, 24_000);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
}

async function runOne(step: (typeof PLAN)[number], onStage: (stage: string) => void) {
  const base = { model: step.model, backend: step.backend };
  const worker = new Worker(new URL("../voice/browserSpeech/kaleTtsTiny.worker.ts", import.meta.url), {
    type: "module",
  });
  const waiting = new Map<number, (data: { samples?: Float32Array<ArrayBuffer>; message?: string }) => void>();
  let loaded: (error: string | null) => void = () => {};
  const ready = new Promise<string | null>((resolve) => (loaded = resolve));
  let cached = false;
  worker.onmessage = ({ data }) => {
    if (data.type === "load") cached = data.cached;
    else if (data.type === "ready") loaded(null);
    else if (data.type === "failed") loaded(data.message);
    else if (data.type === "audio" || data.type === "error") waiting.get(data.id)?.(data);
  };
  worker.onerror = (event) => loaded(event.message || "worker error");
  let nextId = 1;
  const speak = (text: string) =>
    new Promise<Float32Array<ArrayBuffer>>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (data) => (data.samples ? resolve(data.samples) : reject(new Error(data.message))));
      worker.postMessage({ type: "speak", id, text });
    });
  try {
    const started = performance.now();
    worker.postMessage({ type: "load", device: step.backend });
    const error = await ready;
    if (error !== null) return { result: { ...base, error }, audio: null };
    const loadMs = performance.now() - started;
    onStage("loaded");
    const first: number[] = [];
    const line: number[] = [];
    let audio = new Float32Array(0);
    for (let run = 0; run < RUNS; run++) {
      let at = performance.now();
      await speak(VOLCANO[0]!);
      first.push(performance.now() - at);
      at = performance.now();
      audio = await speak(VOLCANO.join(" "));
      line.push(performance.now() - at);
      onStage(`run ${run + 1}/${RUNS}`);
    }
    const audioS = audio.length / RATE;
    const lineMs = median(line);
    const result: RunResult = {
      ...base,
      cached,
      loadMs: Math.round(loadMs),
      firstSoundMs: Math.round(median(first)),
      lineMs: Math.round(lineMs),
      audioS: Math.round(audioS * 100) / 100,
      realtime: Math.round((audioS / (lineMs / 1000)) * 10) / 10,
      firstRunsMs: first.map(Math.round),
      lineRunsMs: line.map(Math.round),
    };
    return { result, audio };
  } catch (error) {
    return { result: { ...base, error: String(error) }, audio: null };
  } finally {
    worker.terminate();
  }
}

async function save(report: Record<string, unknown>) {
  const json = JSON.stringify(report, null, 2);
  if (!SITE) {
    log?.("bench.k10c", report);
    return "Saved to the session log on your computer.";
  }
  const { browserBrain, browserHarness } = await import("../voice/adapters/harness/browser");
  if (!browserBrain()) return "Not paired with your computer here: tap Copy results and send them.";
  const harness = browserHarness();
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  await harness.writeFile!(".lalala/bench/.gitignore", "*\n");
  await harness.writeFile!(`.lalala/bench/k10c-${stamp}.json`, json);
  return "Saved to your computer (.lalala/bench).";
}

async function start() {
  const button = $("run") as HTMLButtonElement;
  button.disabled = true;
  $("rows").innerHTML = "";
  $("saved").textContent = "";
  log = await logger();
  const device = {
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    isolated: self.crossOriginIsolated,
    gpu: await gpuInfo(),
    host: SITE ? "site" : "app",
    text: VOLCANO.join(" "),
    runs: RUNS,
  };
  log?.("bench.start", device);
  const results: RunResult[] = [];
  for (const step of PLAN) {
    const label = `${models[step.model].label} on ${step.backend === "webgpu" ? "WebGPU" : "CPU"}`;
    log?.("bench.step", step);
    $("status").textContent = `${label}: loading…`;
    const { result, audio } =
      step.backend === "webgpu" && !device.gpu.webgpu
        ? { result: { ...step, skipped: `WebGPU isn't available here (${device.gpu.reason})` }, audio: null }
        : await runOne(step, (stage) => {
            $("status").textContent = `${label}: ${stage}`;
          });
    results.push(result);
    // Each run as it ends: a tab the phone kills halfway still leaves the runs before it.
    log?.("bench.run", result);
    addRow(step, result, audio);
  }
  const report = { at: new Date().toISOString(), device, results };
  $("status").textContent = "Done.";
  $("saved").textContent = await save(report).catch((error: unknown) => `Couldn't save: ${String(error)}`);
  const copy = $("copy") as HTMLButtonElement;
  copy.hidden = false;
  copy.onclick = () => void navigator.clipboard.writeText(JSON.stringify(report)).then(() => (copy.textContent = "Copied"));
  button.disabled = false;
  button.textContent = "Run again";
}

function addRow(step: (typeof PLAN)[number], result: RunResult, audio: Float32Array<ArrayBuffer> | null) {
  const row = document.createElement("tr");
  const backend = step.backend === "webgpu" ? "WebGPU" : "CPU";
  const cell = (text: string) => {
    const td = document.createElement("td");
    td.textContent = text;
    row.append(td);
    return td;
  };
  cell(models[step.model].label);
  cell(backend);
  if (result.skipped || result.error) {
    const td = cell(String(result.skipped ?? result.error));
    td.colSpan = 4;
    td.className = "note";
  } else {
    cell(`${sec(result.loadMs)}${result.cached ? "" : " incl. download"}`);
    cell(sec(result.firstSoundMs));
    cell(`${result.realtime}× (${sec(result.lineMs)})`);
    const td = cell("");
    if (audio) {
      const playButton = document.createElement("button");
      playButton.className = "small";
      playButton.textContent = "Play";
      playButton.onclick = () => play(audio);
      td.append(playButton);
    }
  }
  $("rows").append(row);
}

void gpuInfo().then((gpu) => {
  $("gpu").textContent = gpu.webgpu
    ? `WebGPU: yes${gpu.vendor ? ` (${gpu.vendor} ${gpu.architecture})` : ""}`
    : `WebGPU isn't available in this browser (${gpu.reason}): only the CPU runs will run.`;
});
$("run").onclick = () => void start();
// ?bench=k10c&auto starts on its own (the iOS Simulator's memory check has no one to tap).
if (new URLSearchParams(location.search).has("auto")) void start();
