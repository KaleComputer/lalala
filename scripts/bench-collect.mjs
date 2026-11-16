#!/usr/bin/env node
// Turns one ?bench run from lalala's session log (bench.start, bench.line…, bench.done) into the speed
// benchmark JSON: device, runtime, lalala commit, model and line-set hashes, every line run and the
// p50 / p90 / min summary, overall and per line-length bucket.
//   node scripts/bench-collect.mjs --log <sessions-YYYY-MM-DD.jsonl> --out <dir> [--bench <id>]
//     [--device <name>] [--label "<what the device is>"] [--cpu "<cpu>"] [--ram "<ram>"]
// Without --bench it takes the newest finished run. The file is <device>-<model>-<YYYYMMDD-HHMM>.json
// (the run's start, Europe/Berlin). Times in the file are ISO (UTC).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, at, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[at + 1]]);
    return pairs;
  }, []),
);
if (!args.log || !args.out) {
  console.error("usage: bench-collect.mjs --log <sessions.jsonl> --out <dir> [--bench id] [--device name]");
  process.exit(2);
}

const events = fs
  .readFileSync(args.log, "utf8")
  .split("\n")
  .filter((line) => line.includes('"bench.'))
  .map((line) => JSON.parse(line));
const done = events.filter((event) => event.type === "bench.done" && (!args.bench || event.bench === args.bench));
const finish = done.at(-1);
if (!finish) {
  console.error("no finished bench run in that log");
  process.exit(1);
}
const id = finish.bench;
const start = events.find((event) => event.type === "bench.start" && event.bench === id);
const lines = events.filter((event) => event.type === "bench.line" && event.bench === id);

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (...gitArgs) => execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" }).trim();
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
};
const round = (value, places = 0) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);
// First audio: p90 is the slow end. × real time: "p90" is also the slow end (the value 90 % of lines beat).
const summarize = (runs) => ({
  lineRuns: runs.length,
  firstAudioMs: {
    p50: round(quantile(runs.map((run) => run.firstMs), 0.5)),
    p90: round(quantile(runs.map((run) => run.firstMs), 0.9)),
    min: round(quantile(runs.map((run) => run.firstMs), 0)),
  },
  xRealTime: {
    p50: round(quantile(runs.map((run) => run.xrt), 0.5), 1),
    p90: round(quantile(runs.map((run) => run.xrt), 0.1), 1),
    min: round(quantile(runs.map((run) => run.xrt), 0), 1),
  },
  audioSeconds: round(runs.reduce((sum, run) => sum + run.audioS, 0), 1),
});

const lineSetFile = path.join(root, "src/bench/lines.json");
const lineSet = JSON.parse(fs.readFileSync(lineSetFile, "utf8"));
const modelFile = path.join(root, "public/models", start.model, "onnx/model_web.onnx");
const dirty = git("status", "--porcelain", "--", "src/bench", "src/voice/browserSpeech", `public/models/${start.model}`);
// Tim's rule: a phone-sized browser on the Mac is never a phone. "iphone-…" files come only from his own
// runs; a Mac test browser (its user agent says lalala-test or Headless) is "mac webkit, phone-sized".
const macTest = /lalala-test|Headless/.test(start.ua ?? "");
const device = args.device ?? start.device ?? (macTest ? "mac-webkit-phone-sized" : "unknown");
const realIphone = /iPhone/.test(start.ua ?? "") && !macTest;
if (/iphone/i.test(device) && !realIphone) {
  console.error(`refused: run ${id} is not from a real iPhone (user agent: ${(start.ua ?? "").slice(0, 80)}); name it after the Mac browser`);
  process.exit(1);
}
if (macTest && /iPhone|Android/.test(start.ua ?? "") && !args.label) args.label = "mac webkit, phone-sized";
const at = new Date(start.t);
const stamp = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})
  .format(at)
  .replace(/[-:]/g, "")
  .replace(" ", "-");

const report = {
  schema: "lalala speed bench v1",
  device,
  deviceLabel: args.label ?? null,
  model: start.model,
  voice: start.voice,
  startedAt: start.t,
  finishedAt: finish.t,
  lalala: {
    repository: "KaleComputer/lalala",
    commit: git("rev-parse", "HEAD"),
    benchFilesChangedSinceCommit: dirty ? dirty.split("\n") : [],
    benchScript: "src/bench/main.ts",
    collector: "scripts/bench-collect.mjs",
  },
  lineSet: {
    path: "src/bench/lines.json",
    version: lineSet.version,
    sha256: sha256(lineSetFile),
    lines: lineSet.lines.length,
    buckets: Object.fromEntries(
      ["short", "medium", "long", "paragraph"].map((bucket) => [
        bucket,
        lineSet.lines.filter((line) => line.bucket === bucket).length,
      ]),
    ),
  },
  modelFile: {
    path: path.relative(root, modelFile),
    sha256: sha256(modelFile),
    bytes: fs.statSync(modelFile).size,
  },
  runtime: {
    backend: start.backend,
    path: start.runtime ?? null,
    threads: start.threads ?? null,
    onnxruntimeWeb: start.ort ?? null,
    transformersJs: start.transformers ?? null,
    crossOriginIsolated: start.isolated ?? null,
    graphOptimization: "disabled (lalala's setting)",
  },
  browser: {
    userAgent: start.ua,
    brands: start.browsers ?? null,
    platform: start.hintPlatform ?? null,
    architecture: start.hintArch ?? null,
    model: start.hintModel ?? null,
  },
  hardware: {
    cores: start.cores ?? null,
    deviceMemoryGB: start.memoryGB ?? null,
    cpu: args.cpu ?? null,
    ram: args.ram ?? null,
  },
  method: {
    runs: start.runs,
    warmup: "2 lines, not counted",
    lines: "each spoken sentence by sentence through kaleVoice.worker, as lalala's player sends them",
    firstAudio: "from the line's start to its first sentence's audio",
    xRealTime: "the line's audio seconds over its total seconds",
    loadMs: "worker load message to ready (Transformers.js load, session, one warm-up sentence)",
    cold: finish.cold,
  },
  summary: {
    loadMs: start.loadMs,
    peakMemory: { bytes: finish.peakMemoryBytes ?? null, method: finish.memoryMethod },
    runsTimesLines: `${start.runs} × ${start.lines}`,
    all: summarize(lines),
    buckets: Object.fromEntries(
      ["short", "medium", "long", "paragraph"].map((bucket) => [bucket, summarize(lines.filter((run) => run.bucket === bucket))]),
    ),
  },
  lines: lines.map(({ run, id: line, bucket, chars, sentences, audioS, firstMs, totalMs, xrt }) => ({
    run,
    id: line,
    bucket,
    chars,
    sentences,
    audioS,
    firstAudioMs: firstMs,
    totalMs,
    xRealTime: xrt,
  })),
};
if (lines.length !== start.runs * start.lines) report.incomplete = `${lines.length} of ${start.runs * start.lines} line runs logged`;

fs.mkdirSync(args.out, { recursive: true });
const file = path.join(args.out, `${device}-${start.model}${start.runtime ? `-${start.runtime}` : ""}-${stamp}.json`);
fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
const s = report.summary.all;
console.log(
  `${file}\n${device} ${start.model}: first audio p50 ${s.firstAudioMs.p50} ms, p90 ${s.firstAudioMs.p90} ms; ` +
    `× real time p50 ${s.xRealTime.p50}, p90 ${s.xRealTime.p90}; load ${start.loadMs} ms; ${s.lineRuns} line runs`,
);
