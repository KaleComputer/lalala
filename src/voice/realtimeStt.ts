/**
 * Streaming speech-to-text: local Parakeet via `/__lalala/local/stt`, speaking ElevenLabs Scribe
 * realtime's message shapes. 16 kHz PCM streams only while the user talks; a manual commit per utterance
 * returns its transcript. Without a socket, the same engine's batch endpoint takes it, never the other.
 */
import type { SpeechAdapter } from "./adapters";
import { type SpeechEngine, speechEngine, subscribeSpeechEngine } from "./engine";
import { fetchLalala, isGatewayStatus, readJson, VoiceUnreachable } from "./voiceErrors";

export const STT_SAMPLE_RATE = 16_000;
// Five 20 ms frames: the most audio one message carries.
const FRAMES_PER_MESSAGE = 5;

const COMMIT_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 4_000;
const BATCH_RETRIES = 5;
const BATCH_RETRY_MS = 2_000;

function base64OfPcm(chunks: ReadonlyArray<Int16Array>): string {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.byteLength;
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function wavOfPcm(chunks: ReadonlyArray<Int16Array>): Blob {
  let samples = 0;
  for (const chunk of chunks) samples += chunk.length;
  const header = new DataView(new ArrayBuffer(44));
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      header.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  header.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, STT_SAMPLE_RATE, true);
  header.setUint32(28, STT_SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  write(36, "data");
  header.setUint32(40, samples * 2, true);
  return new Blob([header.buffer, ...chunks.map((chunk) => chunk.slice().buffer)], {
    type: "audio/wav",
  });
}

async function transcribeBatch(
  chunks: ReadonlyArray<Int16Array>,
  engine: SpeechEngine,
): Promise<string> {
  const wav = wavOfPcm(chunks);
  // A dropped socket is often lalala restarting: the utterance waits a little for it to come back.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchLalala(`/__lalala/stt?engine=${engine}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav,
      });
      if (isGatewayStatus(response.status)) throw new VoiceUnreachable();
      const body = await readJson<{ text: string; error: string }>(response);
      if (!response.ok) throw new Error(body.error ?? `transcription failed (${response.status})`);
      if (typeof body.text !== "string") throw new VoiceUnreachable();
      return body.text.trim();
    } catch (cause) {
      if (!(cause instanceof VoiceUnreachable) || attempt >= BATCH_RETRIES) throw cause;
      await new Promise((resolve) => window.setTimeout(resolve, BATCH_RETRY_MS));
    }
  }
}

async function socketUrl(_engine: SpeechEngine): Promise<string> {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/__lalala/local/stt`;
}

type PendingCommit = {
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
};

export class RealtimeStt {
  private socket: WebSocket | null = null;
  /** The engine of the open (or opening) socket and of the utterance in progress. */
  private engine: SpeechEngine = speechEngine();
  private ready: Promise<WebSocket> | null = null;
  /** Switches the socket as soon as the engine choice changes, so the next utterance finds it open. */
  private unsubscribe: (() => void) | null = null;
  private pending: PendingCommit[] = [];
  private closed = false;
  /** The current utterance, kept for the batch fallback. */
  private utterance: Int16Array[] = [];
  /** Interim text of the segment being streamed; used to tell the user from our own echo. */
  onPartial: ((text: string) => void) | null = null;
  private unsent: Int16Array[] = [];
  /**
   * Text the service committed by itself (Scribe does after ~1 s of silence, even with manual
   * commits) before ours: the start of the same utterance, so it leads its partials and its result.
   */
  private carry: string[] = [];
  /** The open local socket transcribes only what its voice detection called speech. */
  private vad = false;
  /** lalala.talk's in-browser speech (the speech adapter) instead of the local service's socket. */
  private readonly adapter = globalThis.__lalalaAdapters?.speech;
  private session: ReturnType<SpeechAdapter["listen"]> | null = null;

  /**
   * Whether a transcript can only come from real speech: Scribe always (its own voice detection),
   * local speech only once its service runs Silero in front of Parakeet (`vad` on session start).
   */
  get speechOnly(): boolean {
    return this.engine !== "local" || (this.socket !== null && this.vad);
  }

  /**
   * Opens the socket ahead of time so the first utterance does not wait for it. Called as each
   * utterance starts: a changed engine choice switches the socket here, between utterances.
   */
  warm(): void {
    if (this.adapter) {
      this.session ??= this.adapter.listen();
      this.session.catch(() => (this.session = null));
      return;
    }
    const engine = speechEngine();
    if (engine !== this.engine && this.pending.length === 0) {
      this.engine = engine;
      const socket = this.socket;
      this.socket = null;
      this.ready = null;
      socket?.close();
    }
    void this.connect().catch(() => {});
  }

  close(): void {
    void this.session?.then((session) => session.close()).catch(() => {});
    this.session = null;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const commit of this.pending) commit.reject(new Error("closed"));
    this.pending = [];
    this.socket?.close();
    this.socket = null;
    this.ready = null;
  }

  /** Streams audio of the utterance in progress; sends in ~100 ms batches. */
  push(chunk: Int16Array): void {
    this.utterance.push(chunk);
    if (this.adapter) return;
    this.unsent.push(chunk);
    if (this.unsent.length >= 5) this.flush(false);
  }

  /** Drops the utterance in progress (it was noise or our own echo). */
  discard(): void {
    this.utterance = [];
    this.unsent = [];
    this.carry = [];
  }

  /** Ends the utterance and resolves with its transcript. `fallback: false` skips the batch retry. */
  async commit({ fallback = true }: { readonly fallback?: boolean } = {}): Promise<string> {
    const utterance = this.utterance;
    if (this.adapter) {
      this.utterance = [];
      this.warm();
      const session = await this.session!;
      for (const chunk of utterance) session.send(chunk);
      return (await session.commit()).trim();
    }
    const engine = this.engine;
    const commit = new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
    // Every commit carries some audio, even when the batches already went out.
    if (this.unsent.length === 0) this.unsent.push(new Int16Array(STT_SAMPLE_RATE / 50));
    const sent = this.flush(true);
    this.utterance = [];
    if (!sent) {
      this.pending.pop();
      return fallback ? transcribeBatch(utterance, engine) : "";
    }
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("commit timed out")), COMMIT_TIMEOUT_MS);
    });
    try {
      const text = await Promise.race([commit, timeout]);
      // A session that reconnected mid-utterance can commit only silence; the batch has it all.
      return text === "" && fallback ? await transcribeBatch(utterance, engine) : text;
    } catch {
      // A dropped socket or a slow commit: the batch endpoint still has the whole utterance.
      this.socket?.close();
      return fallback ? transcribeBatch(utterance, engine) : "";
    } finally {
      window.clearTimeout(timer);
    }
  }

  private flush(commit: boolean): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      this.warm();
      return false;
    }
    const chunks = this.unsent;
    this.unsent = [];
    // At most ~100 ms per message: Scribe drops a large one without a word (2 Nov: a 2.8 s message
    // came back empty), and audio buffered while the socket reconnected is often longer than that.
    for (let start = 0; start < chunks.length; start += FRAMES_PER_MESSAGE) {
      const last = start + FRAMES_PER_MESSAGE >= chunks.length;
      socket.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64OfPcm(chunks.slice(start, start + FRAMES_PER_MESSAGE)),
          commit: commit && last,
          sample_rate: STT_SAMPLE_RATE,
        }),
      );
    }
    return true;
  }

  private connect(): Promise<WebSocket> {
    this.unsubscribe ??= subscribeSpeechEngine(() => this.warm());
    if (this.ready !== null) return this.ready;
    this.closed = false;
    const engine = this.engine;
    const ready = (async () => {
      const socket = new WebSocket(await socketUrl(engine));
      socket.onmessage = (event) => this.onMessage(event);
      // A closed session reconnects on the next utterance.
      socket.onclose = () => {
        if (this.engine !== engine) return;
        if (this.socket !== socket && this.socket !== null) return;
        this.socket = null;
        if (this.ready === ready) this.ready = null;
        for (const commit of this.pending) commit.reject(new Error("socket closed"));
        this.pending = [];
      };
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error("connect timed out")),
          CONNECT_TIMEOUT_MS,
        );
        socket.addEventListener("message", function started(event) {
          if (String(event.data).includes("session_started")) {
            window.clearTimeout(timer);
            socket.removeEventListener("message", started);
            resolve();
          }
        });
        socket.addEventListener("close", () => reject(new Error("socket closed")), { once: true });
      });
      if (this.closed || this.engine !== engine) {
        socket.close();
        throw new Error("closed");
      }
      this.socket = socket;
      return socket;
    })();
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    this.ready = ready;
    return ready;
  }

  private onMessage(event: MessageEvent): void {
    let message: { message_type?: string; text?: string; error?: string; vad?: unknown };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.message_type === "session_started") {
      this.vad = message.vad === true;
    } else if (message.message_type === "partial_transcript") {
      if (message.text) this.onPartial?.([...this.carry, message.text].join(" "));
    } else if (message.message_type === "committed_transcript") {
      const text = message.text?.trim() ?? "";
      const commit = this.pending.shift();
      if (commit === undefined) {
        if (text !== "") this.carry.push(text);
        return;
      }
      commit.resolve([...this.carry, text].filter(Boolean).join(" "));
      this.carry = [];
    } else if (message.error !== undefined) {
      this.pending.shift()?.reject(new Error(message.error));
    }
  }
}
