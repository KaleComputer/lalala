// Speech in the browser: Kokoro (tts.worker.ts) speaks, the Web Speech API listens.

type WorkerMessage =
  | { type: "progress"; progress: number }
  | { type: "ready"; device: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number }
  | { type: "error"; id: number; message: string };

/** Plays sentences in order as Kokoro renders them; `onIdle` once everything queued has played. */
export class Speaker {
  #worker: Worker;
  #context: AudioContext | null = null;
  #nextAt = 0;
  #nextId = 1;
  #generation = 0;
  #waiting = new Map<number, number>();
  #sources = new Set<AudioBufferSourceNode>();
  onIdle = () => {};
  onPlaying = (_playing: boolean) => {};
  onStatus = (_status: string) => {};

  constructor() {
    this.#worker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.#onMessage(event.data);
    this.#worker.postMessage({ type: "load" });
  }

  /** Call from a click: browsers only start audio inside a user gesture. */
  unlock() {
    this.#context ??= new AudioContext();
    void this.#context.resume();
  }

  get speaking() {
    return this.#waiting.size > 0 || this.#sources.size > 0;
  }

  speak(text: string) {
    const clean = toSpeakable(text);
    if (!clean) return;
    const id = this.#nextId++;
    this.#waiting.set(id, this.#generation);
    this.#worker.postMessage({ type: "speak", id, text: clean });
  }

  stop() {
    this.#generation++;
    this.#waiting.clear();
    for (const source of this.#sources) source.stop();
    this.#sources.clear();
    this.onPlaying(false);
    this.#nextAt = 0;
  }

  dispose() {
    this.stop();
    this.#worker.terminate();
    void this.#context?.close();
  }

  #onMessage(message: WorkerMessage) {
    if (message.type === "progress") this.onStatus(`Loading voice ${Math.round(message.progress)}%`);
    else if (message.type === "ready") this.onStatus(`Voice ready (${message.device})`);
    else if (message.type === "error") {
      this.#waiting.delete(message.id);
      this.onStatus(`Voice failed: ${message.message}`);
      this.#settle();
    } else if (message.type === "audio") {
      const generation = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);
      if (generation !== this.#generation || !this.#context) return this.#settle();
      const context = this.#context;
      const buffer = context.createBuffer(1, message.samples.length, message.rate);
      buffer.copyToChannel(message.samples as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime + 0.02, this.#nextAt);
      source.start(at);
      if (this.#sources.size === 0) this.onPlaying(true);
      this.#nextAt = at + buffer.duration;
      this.#sources.add(source);
      source.onended = () => {
        this.#sources.delete(source);
        this.#settle();
      };
    }
  }

  #settle() {
    if (this.#sources.size === 0) this.onPlaying(false);
    if (!this.speaking) this.onIdle();
  }
}

/** Drops what reads badly aloud: code blocks, markdown marks, bare links. */
export function toSpeakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^[#>\-*\s]+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits streamed text into the part that ends on a sentence boundary and the rest. */
export function takeSentences(text: string, final: boolean) {
  if (final) return { ready: text, rest: "" };
  const match = /[\s\S]*(?:[.!?…:](?=\s)|\n)/.exec(text);
  if (!match) return { ready: "", rest: text };
  return { ready: match[0], rest: text.slice(match[0].length) };
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export const canListen = () =>
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

/** One utterance: interim text while speaking, the final transcript at the end ("" if none). */
export function listenOnce(handlers: {
  onInterim: (text: string) => void;
  onDone: (text: string) => void;
  onError: (error: string) => void;
}) {
  const w = window as unknown as Record<string, new () => Recognition>;
  const recognition = new (w.SpeechRecognition ?? w.webkitSpeechRecognition)();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    finalText = "";
    for (const result of Array.from(event.results)) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    handlers.onInterim((finalText + interim).trim());
  };
  recognition.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") handlers.onError(event.error);
  };
  recognition.onend = () => handlers.onDone(finalText.trim());
  recognition.start();
  return { stop: () => recognition.stop(), abort: () => recognition.abort() };
}
