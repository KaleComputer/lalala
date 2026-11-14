// Kokoro 82M on ONNX (kokoro-js), the reply voice, rendered off the page's thread. The libraries come
// from the CDN: the page ships no copy of them.
import { trackFiles } from "./readout";
import { forgetDownloads, resumableFetch } from "./resumableFetch";

self.fetch = resumableFetch(self.fetch.bind(self));

const KOKORO_JS = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const PHONEMIZER = "https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

type Ids = { readonly dims: ReadonlyArray<number> };
type KokoroTTS = {
  generate(text: string, options: { voice: string }): Promise<RenderedAudio>;
  generate_from_ids(ids: Ids, options: { voice: string }): Promise<RenderedAudio>;
  tokenizer(text: string, options: { truncation: boolean }): { input_ids: Ids };
};
type RenderedAudio = { audio: Float32Array<ArrayBuffer>; sampling_rate: number };
type KokoroModule = {
  KokoroTTS: {
    from_pretrained(
      model: string,
      options: { dtype: string; device: string; progress_callback: (info: object) => void },
    ): Promise<KokoroTTS>;
  };
};
type Phonemize = (text: string, language: string) => Promise<string[]>;

let model: Promise<KokoroTTS> | null = null;
let phonemizer: Promise<Phonemize> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function cached(file: string) {
  try {
    const cache = await caches.open("transformers-cache");
    return (
      (await cache.match(`https://huggingface.co/${MODEL}/resolve/main/${file}`)) !== undefined
    );
  } catch {
    return false;
  }
}

async function load() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  // A phone keeps its memory for Parakeet's fp16 encoder: the 93 MB quantized Kokoro on WASM there.
  const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
  const webgpu = !phone && gpu ? (await gpu.requestAdapter().catch(() => null)) !== null : false;
  const isCached = await cached(webgpu ? "onnx/model.onnx" : "onnx/model_quantized.onnx");
  if (isCached) void forgetDownloads(`https://huggingface.co/${MODEL}/`).catch(() => {});
  postMessage({
    type: "load",
    name: "kokoro 82m",
    // The model and a voice, so the readout knows the size before the first byte.
    expected: webgpu ? 327_000_000 : 93_000_000,
    cached: isCached,
  });
  const { KokoroTTS } = (await import(/* @vite-ignore */ KOKORO_JS)) as KokoroModule;
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    // WebGPU wants the full-precision model; the quantized one suits WASM.
    dtype: webgpu ? "fp32" : "q8",
    device: webgpu ? "webgpu" : "wasm",
    progress_callback: trackFiles((loaded, total) =>
      postMessage({ type: "progress", loaded, total }),
    ),
  });
  // One short render compiles the shaders, so the first reply is not the slow one.
  await tts.generate("Hi.", { voice: VOICE });
  postMessage({ type: "ready" });
  return tts;
}

// kokoro-js's own text normalization and phonemization (its dist/kokoro.js, Apache-2.0), which it
// does not export: needed to read misaki's `[word](/phonemes/)` markup (pronunciations.ts) inline.
// The em dash by code: it is punctuation here, not copy.
const PUNCTUATION = `;:,.!?¡¿${String.fromCharCode(0x2014)}…"«»“”(){}[]`;
const PUNCTUATION_RUN = new RegExp(
  `(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g",
);

function splitNumber(match: string) {
  if (match.includes(".")) return match;
  if (match.includes(":")) {
    const [hours, minutes] = match.split(":").map(Number) as [number, number];
    if (minutes === 0) return `${hours} o'clock`;
    if (minutes < 10) return `${hours} oh ${minutes}`;
    return `${hours} ${minutes}`;
  }
  const year = Number.parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = Number.parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function money(match: string) {
  const unit = match[0] === "$" ? "dollar" : "pound";
  if (Number.isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${unit}s`;
  if (!match.includes(".")) {
    const plural = match.slice(1) === "1" ? "" : "s";
    return `${match.slice(1)} ${unit}${plural}`;
  }
  const [whole, fraction] = match.slice(1).split(".") as [string, string];
  const cents = Number.parseInt(fraction.padEnd(2, "0"), 10);
  const small =
    match[0] === "$" ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence";
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${small}`;
}

function pointNumber(match: string) {
  const [whole, fraction] = match.split(".") as [string, string];
  return `${whole} point ${fraction.split("").join(" ")}`;
}

function normalize(text: string) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, '"')
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
      money,
    )
    .replace(/\d*\.\d+/g, pointNumber)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

async function phonemizePlain(text: string, phonemize: Phonemize) {
  const pieces: Array<{ match: boolean; text: string }> = [];
  let at = 0;
  for (const run of text.matchAll(PUNCTUATION_RUN)) {
    if (at < run.index) pieces.push({ match: false, text: text.slice(at, run.index) });
    if (run[0].length > 0) pieces.push({ match: true, text: run[0] });
    at = run.index + run[0].length;
  }
  if (at < text.length) pieces.push({ match: false, text: text.slice(at) });
  const joined = (
    await Promise.all(
      pieces.map(async (piece) =>
        piece.match ? piece.text : (await phonemize(piece.text, "en-us")).join(" "),
      ),
    )
  ).join("");
  return joined
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿\u2014…"«»“” ]|$)/g, "z")
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, "di")
    .trim();
}

const MARKUP = /\[([^\]]+)\]\(\/([^/]+)\/\)/g;

/** Phonemes for text with misaki markup: listed words as given, the rest as kokoro-js would. */
async function phonemesWithMarkup(text: string) {
  phonemizer ??= import(/* @vite-ignore */ PHONEMIZER).then(
    (module: { phonemize: Phonemize }) => module.phonemize,
  );
  const phonemize = await phonemizer;
  let out = "";
  let at = 0;
  const add = (phonemes: string, spaced: boolean) => {
    if (phonemes === "") return;
    out += out !== "" && spaced ? ` ${phonemes}` : phonemes;
  };
  for (const mark of text.matchAll(MARKUP)) {
    const before = text.slice(at, mark.index);
    add(await phonemizePlain(normalize(before), phonemize), /^\s/.test(before) || at === 0);
    add(mark[2]!, before === "" || /\s$/.test(before));
    at = mark.index + mark[0].length;
  }
  const rest = text.slice(at);
  add(await phonemizePlain(normalize(rest), phonemize), /^\s/.test(rest));
  return out;
}

async function render(tts: KokoroTTS, text: string) {
  if (!text.includes("](/")) return tts.generate(text, { voice: VOICE });
  const { input_ids } = tts.tokenizer(await phonemesWithMarkup(text), { truncation: true });
  return tts.generate_from_ids(input_ids, { voice: VOICE });
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; text?: string }>) => {
  const message = event.data;
  if (model === null) {
    model = load();
    model.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
  }
  if (message.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const audio = await render(await model!, message.text!);
      const samples = audio.audio;
      postMessage(
        { type: "audio", id: message.id, samples, rate: audio.sampling_rate },
        { transfer: [samples.buffer] },
      );
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
