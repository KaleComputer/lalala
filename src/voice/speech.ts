/**
 * Hands-free speech for lalala: open mic, Presence's close-talk gate, realtime speech-to-text and
 * replies spoken sentence by sentence. Only the user talking close to the mic starts a turn or cuts a reply
 * (presence/closetalk.js); a reply stops only when the gate hears them and the transcript has their words.
 */
import { type SpeechEngine, speechEngine } from "./engine";
import { SpeechPlayer } from "./player";
import { type CloseTalkMode, createCloseTalk } from "./presence/closetalk";
import { RealtimeStt, STT_SAMPLE_RATE } from "./realtimeStt";
import {
  foreignWords,
  hasForeignRun,
  hasRealWords,
  isNoisePhrase,
  isEchoOfSpoken,
  speakableText,
  stripEcho,
} from "./speechText";
import { TopicHold } from "./topicHold";
import { VoiceComb } from "./voiceComb";
import { micDeviceId } from "./settingsStore";
import { voiceErrorText } from "./voiceErrors";
import { voiceLog } from "./voiceLog";
import { VoiceSounds } from "./voiceSounds";
import { soundOutput } from "./extras/soundVolume";

export type VoicePhase = "off" | "listening" | "hearing" | "transcribing" | "speaking";

export type VoiceSessionEvents = {
  readonly onPhase: (phase: VoicePhase) => void;
  readonly onUtterance: (text: string) => void;
  readonly onError: (message: string) => void;
  /** A reply was cut off (barge-in): the bar shows Presence's stopped look. */
  readonly onStopped?: (reason: string) => void;
  /** The platform took the mic away (iOS: another app's audio) or gave it back. */
  readonly onMicPaused?: (paused: boolean) => void;
};

const FRAME_MS = 20;
const FRAME_SAMPLES = (STT_SAMPLE_RATE * FRAME_MS) / 1000;
const PRE_ROLL_FRAMES = 15;
// Wind, breath and handling rumble sit under this (Presence's WIND_CUT_HZ).
const WIND_CUT_HZ = 180;
// Our reply's echo is still in the room this long after its audio ends.
const ECHO_TAIL_MS = 600;
// While a reply plays the mic is transcribed in segments this long, to look for the user's words.
const PROBE_SEGMENT_MS = 2_000;
// The gate heard the user close while the reply played: their words must show within this.
const BARGE_WINDOW_MS = 2_500;
// Our own "heard you" tick is never the user (Presence's gate.ignore during its call sounds).
const BLIP_IGNORE_MS = 180;
// A transcript taken over the reply counts as the user when this share of its words are their (or it is short).
const MIN_THEIR_SHARE = 0.3;
const MAX_SHORT_INTERRUPTION = 6;
// The user's close voice during a reply silences it at once ("when I start talking, you stop
// talking immediately"). With no word of their in this long after the gate closes, or at most
// HOLD_MAX_MS, it was noise and the reply goes on.
const HOLD_RELEASE_MS = 700;
const HOLD_MAX_MS = 5_000;
// Our reply coming back through a speaker is quieter at the mic than the reply itself; the user talking
// into it is not. A hold needs the mic within this many dB of what is playing, for HOLD_OVER_MS.
const HOLD_OVER_REPLY_DB = 3;
const HOLD_OVER_MS = 60;
// A segment never runs longer than this, even while the gate stays open on loud echo.
const MAX_SEGMENT_MS = 6_000;
// Under this much speech a lone word is a noise the recogniser named ("you", "the").
const MIN_LONE_WORD_MS = 500;
/**
 * How long after the gate closes (its own HOLD_MS of quiet, ~0.7 s, already past) the user's turn ends,
 * by how their words so far end: a finished sentence ends soon, a pause after "and" or "um" waits.
 */
// A turn ends only after real silence, however long the user talks (2 Nov: "never end my turn while I'm
// still speaking"): the gate's ~0.7 s hold, then this long with the mic near the room's floor and no
// new words. ~1.8 s after a finished sentence, ~2.3 s mid-sentence, ~3 s after "um" or "and".
const END_AFTER_SENTENCE_MS = 1_100;
const END_OPEN_MS = 1_600;
const END_HESITATION_MS = 2_300;
// Quiet means within this many dB of the room's floor: their soft trailing words are not.
const QUIET_OVER_FLOOR_DB = 8;
// Loud is the user only with a voice in it (Presence's harmonic comb, voiceComb.ts) this recently: steps,
// traffic and wind never hold a turn open, hold a reply back or pause it (2 Nov, walking: steps kept
// turns open 7-18 s and paused "One moment." for 5 s).
const VOICE_HOLD_MS = 700;
// The comb counts once it heard the user in a turn with words this long; until then levels decide alone,
// as before (it fails open, like Presence's gate stages).
const VOICE_PROOF_MS = 300;
// A turn that starts this soon after the user's voice or words is likely them going on after a split
// (outside the comb misses them): until it shows a voice or ends as noise, a ready reply waits for it
// (3 Nov, walking: replies started 0.1 s into their next turn). It never shows them talking.
const FOLLOW_ON_MS = 3_000;
// Outside the comb barely hears the user and partials lag their words, so a turn ended in the middle of their
// sentence (3 Nov, 16:13:52-16:14:19: the gate open 27 s on them, six turns, six blips). In their turn,
// a gate open without a break since the comb or new words last showed them is still them, for at most
// this long past them. A gate that steps or a door open anew never counts.
const GATE_CARRY_MS = 3_000;
// Back in the foreground, a mic that still hears nothing after this is opened again.
const REOPEN_AFTER_MS = 1_500;
// Reopens per return to the foreground: another app still playing can take it again each time.
const MAX_REOPENS = 3;
// While the mic is paused and the page visible, the context is asked to run again this often.
const REVIVE_EVERY_MS = 1_000;
// A tap this soon after the mic came back was the tap that brought it back, not a hang-up.
const REVIVE_TAP_MS = 1_000;
const HESITATION =
  /(?:,|\b(?:um+|uh+|er+|erm|and|but|so|or|because|cause|like|the|a|an|to|of|for|with|that|which|if|when|then|i|my|your|is|are|was|were|we|you|it)\s*)$/i;
// Backchannels never cut a reply off (ElevenLabs' interruption ignore terms, which Presence uses).
const BACKCHANNEL = new Set([
  "ok",
  "okay",
  "right",
  "sure",
  "yes",
  "yeah",
  "yep",
  "mhm",
  "mm",
  "hmm",
  "uh",
  "huh",
  "alright",
  "cool",
  "nice",
  "got",
  "it",
]);

// Captures the microphone as 16 kHz mono PCM in 20 ms frames, with each frame's level.
const CAPTURE_WORKLET = `
class LalalaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / ${STT_SAMPLE_RATE};
    this.position = 0;
    this.frame = new Int16Array(${FRAME_SAMPLES});
    this.filled = 0;
    this.energy = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (; this.position < input.length; this.position += this.step) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(this.position)]));
      this.energy += sample * sample;
      this.frame[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === this.frame.length) {
        const level = Math.sqrt(this.energy / this.filled);
        this.port.postMessage({ pcm: this.frame, level }, [this.frame.buffer]);
        this.frame = new Int16Array(${FRAME_SAMPLES});
        this.filled = 0;
        this.energy = 0;
      }
    }
    this.position -= input.length;
    return true;
  }
}
registerProcessor("lalala-capture", LalalaCapture);
`;

// Scribe sometimes writes full-width punctuation ("is，um..." / "is。").
function asciiPunctuation(text: string): string {
  return text
    .replace(/[，、]/g, ", ")
    .replace(/。/g, ". ")
    .replace(/？/g, "? ")
    .replace(/！/g, "! ")
    .replace(/\s+/g, " ");
}

/** How long to wait after the gate closed before the user's turn ends, from their words so far. */
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

function endpointWait(partial: string): { readonly ms: number; readonly rule: string } {
  const text = asciiPunctuation(partial).trim();
  if (text === "") return { ms: END_OPEN_MS, rule: "no-words-yet" };
  // A trailing "…" is a voice trailing off, not a finished sentence.
  if (HESITATION.test(text) || /(?:\.\.\.|…)$/.test(text)) {
    return { ms: END_HESITATION_MS, rule: "hesitation" };
  }
  if (/[.!?…]["')\]]*$/.test(text)) return { ms: END_AFTER_SENTENCE_MS, rule: "sentence" };
  return { ms: END_OPEN_MS, rule: "open" };
}

/** Words in `heard` that are neither ours coming back nor a backchannel: the user interrupting. */
function interruptingWords(heard: string, spoken: ReadonlyArray<string>): ReadonlyArray<string> {
  return foreignWords(heard, spoken).filter((word) => !BACKCHANNEL.has(word));
}

/**
 * While a reply is on hold and the gate opened on the user: one word of their that is not our echo nor
 * "mm-hmm" stops it. A hold alone (voiced, not open) never stops anything: loud echo gets that far.
 */
function isTakeover(heard: string, spoken: ReadonlyArray<string>): boolean {
  return !isNoisePhrase(heard) && interruptingWords(heard, spoken).length >= 1;
}

/**
 * Whether a transcript taken while the reply played has the user in it: a run of their words, and enough
 * of them. A long transcript of our own echo always has a few garbled words; the user's are a real share.
 */
function isInterruption(heard: string, spoken: ReadonlyArray<string>): boolean {
  const all = heard.toLowerCase().match(/\p{L}[\p{L}'’]*|\d+/gu) ?? [];
  if (isNoisePhrase(heard)) return false;
  const theirs = interruptingWords(heard, spoken);
  if (theirs.length < 2 || !hasForeignRun(heard, spoken)) return false;
  return all.length <= MAX_SHORT_INTERRUPTION || theirs.length / all.length >= MIN_THEIR_SHARE;
}

export class VoiceSession {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sessionBefore: string | null = null;
  private capture: AudioWorkletNode | null = null;
  private microphone: MediaStreamAudioSourceNode | null = null;
  private windCut: BiquadFilterNode | null = null;
  /** The platform took the mic away (track muted or ended, or the context not running). */
  private micPaused = false;
  private micBackAt = 0;
  private pausedVisibleAt = 0;
  private reviveTimer: number | null = null;
  private reopening = false;
  private reopens = 0;
  private player: SpeechPlayer | null = null;
  private sounds: VoiceSounds | null = null;
  private input: AnalyserNode | null = null;
  private micLevel = 0;
  // The bar's wave reads these every frame; allocated once.
  private readonly spectrum = {
    input: new Uint8Array(1024),
    output: new Uint8Array(1024),
    inputWave: new Float32Array(2048),
    outputWave: new Float32Array(2048),
    rate: 48_000,
  };
  private readonly stt = new RealtimeStt();
  private comb: VoiceComb | null = null;
  private combProven = false;
  private lastVoiceAt = Number.NEGATIVE_INFINITY;
  /** A voice is sounding, or did within VOICE_HOLD_MS (always, until the comb is proven). */
  private voiceLike = true;
  /** The turn in progress has a voice in it (the comb or real words): only then is it the user's. */
  private turnVoiced = false;
  private turnVoiceMs = 0;
  private timVoiceAt = Number.NEGATIVE_INFINITY;
  /** When the comb or new words last showed the user in their turn. */
  private timHeardAt = Number.NEGATIVE_INFINITY;
  /** The gate has stayed open since timHeardAt. */
  private gateHasUser = false;
  /** The turn began within FOLLOW_ON_MS of the user's voice: it holds a ready reply, nothing more. */
  private turnFollowsUser = false;
  // A desktop mic sits further away than a phone held to the mouth: one sensitivity step more.
  private readonly gate = createCloseTalk({
    sensitivity: window.matchMedia("(pointer: coarse)").matches ? 0 : 1,
  });
  private ignoreGateUntil = 0;
  private thinking = false;
  private preRoll: Int16Array[] = [];
  private inSpeech = false;
  private speechMs = 0;
  private closedMs = 0;
  /** The room's level as the gate measures it (dB). */
  private floorDb = -60;
  private utteranceStartedAt = 0;
  private partial = "";
  private partials = 0;
  private startedDuringReply = false;
  private probing = false;
  private probeMs = 0;
  /** When the gate last opened on the user's voice while a reply played (performance time), or 0. */
  private closeVoiceAt = 0;
  /** When the reply went on hold for the user, and when the gate last heard them close since. */
  private holdAt = 0;
  private heldVoiceAt = 0;
  private holdArmed = true;
  private overReplyMs = 0;
  private replyDbs: number[] = [];
  /** When the gate last opened on the user over a reply (not just voiced). */
  private strongVoiceAt = 0;
  private rejectedInSegment = false;
  private pendingTranscriptions = 0;
  /** Reply sentences held back while the user has the floor. */
  private waiting: Array<{
    readonly text: string;
    readonly topic: string | undefined;
    readonly switching: boolean;
  }> = [];
  /** `[new topic]` parts that wait for the user's turn and its answer to be over. */
  private readonly topics = new TopicHold();
  /** The user muted their mic: the call goes on, and nothing waits for their turn. */
  private muted = false;
  private phase: VoicePhase = "off";
  /** Chosen as each utterance starts; its reply is spoken with the same engine. */
  private engine: SpeechEngine = speechEngine();

  constructor(private readonly events: VoiceSessionEvents) {
    this.stt.onPartial = (text) => this.onPartial(text);
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /**
   * When the comb or new words last showed the user in their turn (performance time). An open gate alone
   * never counts: doors, plates and steps open it too (3 Nov).
   */
  get lastUserVoiceAt(): number {
    return this.timVoiceAt;
  }

  /**
   * Mutes or unmutes the user's mic for the rest of the call. Muting ends their turn (sent if it had their
   * voice), drops a half-heard interruption and lets held replies play.
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    voiceLog("voice", muted ? "mic.mute" : "mic.unmute");
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (!muted) return;
    this.endHeardTurn();
  }

  /** The mic stops hearing the user: their turn ends (sent if it had their voice), held replies play. */
  private endHeardTurn(): void {
    this.micLevel = 0;
    if (this.probing) {
      this.probing = false;
      this.stt.discard();
    }
    if (this.inSpeech) {
      this.inSpeech = false;
      if (this.turnVoiced) this.finishUtterance();
      else this.stt.discard();
    }
    if (this.player?.holding) this.player.release();
    this.updatePhase();
  }

  /** The mic is paused by the platform now, or was until a moment ago (the tap that revived it). */
  get micPausedForTap(): boolean {
    return this.micPaused || performance.now() - this.micBackAt < REVIVE_TAP_MS;
  }

  /**
   * iOS hands the audio session to another app that plays sound (a Telegram video): our track goes
   * muted and the context "interrupted", in the background too. Nothing can hear the user until it ends.
   */
  private readonly checkMic = (): void => {
    const context = this.context;
    const stream = this.stream;
    if (context === null || stream === null) return;
    const tracks = stream.getAudioTracks();
    const ended = tracks.some((track) => track.readyState === "ended");
    const silenced = tracks.some((track) => track.muted);
    const contextState = context.state as string;
    const paused = ended || silenced || contextState !== "running";
    const visible = document.visibilityState === "visible";
    if (paused !== this.micPaused) {
      this.micPaused = paused;
      voiceLog("system", paused ? "mic.paused" : "mic.back", {
        ended,
        muted: silenced,
        context: contextState,
        visibility: document.visibilityState,
      });
      if (paused) this.endHeardTurn();
      else this.micBackAt = performance.now();
      this.events.onMicPaused?.(paused);
    }
    if (!paused || !visible) {
      this.pausedVisibleAt = 0;
      this.reopens = 0;
      if (this.reviveTimer !== null) window.clearTimeout(this.reviveTimer);
      this.reviveTimer = null;
      return;
    }
    // In the foreground again: get the context running, and open the mic anew if it stays deaf.
    this.pausedVisibleAt ||= performance.now();
    if (contextState !== "running" && contextState !== "closed") {
      void context.resume().catch(() => {});
    }
    const deaf = ended || (silenced && performance.now() - this.pausedVisibleAt >= REOPEN_AFTER_MS);
    if (deaf && !this.reopening && this.reopens < MAX_REOPENS) {
      this.reopens += 1;
      void this.reopenMic();
    }
    this.reviveTimer ??= window.setTimeout(() => {
      this.reviveTimer = null;
      this.checkMic();
    }, REVIVE_EVERY_MS);
  };

  /** The user tapped the paused bar: run the context and open the mic anew if it is still deaf. */
  revive(): void {
    const context = this.context;
    if (context === null) return;
    voiceLog("voice", "mic.revive", { context: context.state });
    void context.resume().catch(() => {});
    const deaf = (this.stream?.getAudioTracks() ?? []).some(
      (track) => track.muted || track.readyState === "ended",
    );
    if (deaf && !this.reopening) void this.reopenMic();
    else this.checkMic();
  }

  /** Asks for the microphone again and puts it where the old one was in the graph. */
  private async reopenMic(): Promise<void> {
    const context = this.context;
    const windCut = this.windCut;
    if (context === null || windCut === null) return;
    this.reopening = true;
    try {
      const stream = await this.openMic();
      if (this.context !== context || this.stream === null) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const old = this.stream;
      this.microphone?.disconnect();
      this.microphone = context.createMediaStreamSource(stream);
      this.microphone.connect(windCut);
      this.stream = stream;
      for (const track of old.getTracks()) track.stop();
      this.watchTracks(stream);
      for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
      voiceLog("system", "mic.reopen", { context: context.state });
    } catch (cause) {
      voiceLog("system", "error", { where: "mic.reopen", message: String(cause) });
    } finally {
      this.reopening = false;
      this.pausedVisibleAt = 0;
      this.checkMic();
    }
  }

  private openMic(): Promise<MediaStream> {
    // Presence's microphone: echo cancellation and noise suppression on, auto gain off (it lifts far
    // voices in the pauses and flattens the user's, the difference the gate reads), voice isolation where
    // the platform has it.
    const constraints: MediaTrackConstraints & { voiceIsolation?: boolean } = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      voiceIsolation: true,
    };
    // The mic picked in the settings (per device); gone or refused, the system's default.
    const deviceId = micDeviceId();
    return navigator.mediaDevices
      .getUserMedia({
        audio: deviceId === null ? constraints : { ...constraints, deviceId: { exact: deviceId } },
      })
      .catch((cause: unknown) => {
        if (deviceId === null || (cause as { name?: string }).name === "NotAllowedError") {
          throw cause;
        }
        voiceLog("system", "error", { where: "mic.device", message: String(cause) });
        return navigator.mediaDevices.getUserMedia({ audio: constraints });
      });
  }

  private watchTracks(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        voiceLog("system", "mic.ended", { label: track.label });
        this.checkMic();
      });
      track.addEventListener("mute", () => {
        voiceLog("system", "mic.muted");
        this.checkMic();
      });
      track.addEventListener("unmute", () => {
        voiceLog("system", "mic.unmuted");
        this.checkMic();
      });
    }
  }

  /** The brain is working on a reply: the user needs a little more to cut in (Presence's "think" bar). */
  setThinking(thinking: boolean): void {
    this.thinking = thinking;
  }

  async start(): Promise<void> {
    if (this.stream !== null) return;
    // Mobile Safari only starts audio inside the tap itself, so the context comes before any await,
    // and play-and-record keeps replies audible with the ringer switch on silent.
    const context = new AudioContext();
    this.context = context;
    void context.resume();
    const audioSession = (navigator as { audioSession?: { type: string } }).audioSession;
    if (audioSession !== undefined) {
      this.sessionBefore = audioSession.type;
      audioSession.type = "play-and-record";
    }
    this.engine = speechEngine();
    this.stt.warm();
    this.stream = await this.openMic();
    const moduleUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    await context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const capture = new AudioWorkletNode(context, "lalala-capture");
    capture.port.onmessage = (event: MessageEvent<{ pcm: Int16Array; level: number }>) =>
      this.onFrame(event.data.pcm, event.data.level);
    const microphone = context.createMediaStreamSource(this.stream);
    const windCut = context.createBiquadFilter();
    windCut.type = "highpass";
    windCut.frequency.value = WIND_CUT_HZ;
    microphone.connect(windCut);
    this.microphone = microphone;
    this.windCut = windCut;
    windCut.connect(capture);
    this.input = context.createAnalyser();
    this.input.fftSize = 2048;
    this.input.smoothingTimeConstant = 0.8;
    windCut.connect(this.input);
    this.comb = new VoiceComb(context);
    windCut.connect(this.comb.analyser);
    // A silent sink keeps the capture node pulled by the audio graph.
    const sink = context.createGain();
    sink.gain.value = 0;
    capture.connect(sink).connect(context.destination);
    this.capture = capture;
    this.player = new SpeechPlayer(
      context,
      () => this.updatePhase(),
      this.events.onError,
      () => this.engine,
    );
    this.sounds = new VoiceSounds(context);
    voiceLog("system", "mic.open", {
      engine: this.engine,
      context: context.state,
      rate: context.sampleRate,
      settings: this.stream.getAudioTracks()[0]?.getSettings?.() ?? null,
    });
    // iOS: opening the microphone switches the audio session and can leave the context suspended.
    if ((context.state as string) !== "running") void context.resume().catch(() => {});
    // The platform can take the mic away mid-call (iOS: another app's audio); say so and take it back.
    this.watchTracks(this.stream);
    context.addEventListener("statechange", this.checkMic);
    document.addEventListener("visibilitychange", this.checkMic);
    window.addEventListener("pageshow", this.checkMic);
    // A touch anywhere is the surest way to get a stalled iOS context running again.
    document.addEventListener("touchend", this.onTouch, { passive: true });
    this.updatePhase();
    this.sounds.connected();
    this.checkMic();
  }

  private readonly onTouch = (): void => {
    const context = this.context;
    if (context !== null && (context.state as string) !== "running") {
      voiceLog("voice", "audio.context.touch", { state: context.state });
      void context.resume().catch(() => {});
    }
    this.checkMic();
  };

  stop(): void {
    this.waiting = [];
    this.topics.clear();
    this.muted = false;
    this.player?.stop("call ended");
    this.player?.dispose();
    this.sounds?.silence();
    document.removeEventListener("touchend", this.onTouch);
    this.context?.removeEventListener("statechange", this.checkMic);
    document.removeEventListener("visibilitychange", this.checkMic);
    window.removeEventListener("pageshow", this.checkMic);
    if (this.reviveTimer !== null) window.clearTimeout(this.reviveTimer);
    this.reviveTimer = null;
    if (this.micPaused) this.events.onMicPaused?.(false);
    this.micPaused = false;
    this.stt.close();
    if (this.capture !== null) this.capture.port.onmessage = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close();
    // iOS keeps a play-and-record session after the call, and other audio on the page then plays distorted.
    const audioSession = (navigator as { audioSession?: { type: string } }).audioSession;
    if (audioSession?.type === "play-and-record" && this.sessionBefore !== null) {
      audioSession.type = this.sessionBefore;
    }
    this.sessionBefore = null;
    this.stream = null;
    this.context = null;
    this.capture = null;
    this.microphone = null;
    this.windCut = null;
    this.player = null;
    this.sounds = null;
    this.input = null;
    this.comb = null;
    this.inSpeech = false;
    this.probing = false;
    this.setPhase("off");
  }

  /**
   * Queues one sentence of a reply (`opensReply` on its first and on one the brain marked
   * `[new topic]`, which is `switching`); empty or markdown-only text stays silent. `part` names
   * the `[new topic]` part it belongs to, held while the user's own turn is open (topicHold).
   */
  speak(text: string, opensReply = false, switching = false, part?: string): void {
    const spoken = speakableText(text);
    if (spoken === "") return;
    // Replies bringing in something from outside open with a label ("Kokoro: ...", a thread title): brain.md.
    const topic = opensReply
      ? /^([^:.!?]{1,80}):\s/.exec(spoken)?.[1]?.trim().toLowerCase()
      : undefined;
    const now = performance.now();
    if (part !== undefined) {
      const wasHeld = this.topics.count;
      if (this.topics.hold({ text: spoken, topic, switching, part }, this.topicBusy(now), now)) {
        if (this.topics.count > wasHeld)
          voiceLog("voice", "topic.held", { text: spoken, held: this.topics.count });
        return;
      }
    }
    // Never over the user: a reply that arrives while the user talks (or their words are still being written
    // down) waits until their turn is over (2 Nov: a reply woken by another thread talked over them).
    if (this.timHasTheFloor() || this.waiting.length > 0) {
      if (this.waiting.length === 0) voiceLog("voice", "say.waiting", { text: spoken });
      this.waiting.push({ text: spoken, topic, switching });
      return;
    }
    if (this.inSpeech) this.dropNoiseTurn("a reply is ready");
    this.sounds?.silence();
    this.player?.speak(spoken, topic, switching);
  }

  /** The user's words went to the brain: `[new topic]` parts wait until its answer has been heard. */
  awaitAnswer(): void {
    this.topics.awaitAnswer(performance.now());
  }

  /** The brain's answer to the user's words is complete; held topics follow once it has played. */
  answered(): void {
    this.topics.answered();
  }

  /** The user has the floor, or a reply is still waiting, playing or echoing: no held topic starts. */
  private topicBusy(now: number): boolean {
    const player = this.player;
    return (
      this.timHasTheFloor() ||
      this.waiting.length > 0 ||
      (player !== null && (player.speaking || now < player.audibleUntil + ECHO_TAIL_MS))
    );
  }

  /** Plays the next held topic when its time has come (every frame). */
  private releaseTopic(player: SpeechPlayer, now: number): void {
    const topic = this.topics.next(this.topicBusy(now), now);
    if (topic.length === 0) return;
    voiceLog("voice", "topic.released", { text: topic[0]?.text, held: this.topics.count });
    if (this.inSpeech) this.dropNoiseTurn("a topic is ready");
    this.sounds?.silence();
    for (const sentence of topic) player.speak(sentence.text, sentence.topic, sentence.switching);
  }

  /** The user talking: a turn with their voice in it, the gate open on a voice, or their words being written. */
  private timHasTheFloor(): boolean {
    if (this.muted) return false;
    return (
      (this.inSpeech && (this.turnVoiced || this.turnFollowsUser)) ||
      (this.gate.open && this.voiceLike) ||
      this.pendingTranscriptions > 0
    );
  }

  /** A turn the gate opened on noise alone: no words, no voice. Nothing of it is the user's. */
  private dropNoiseTurn(reason: string): void {
    if (!this.inSpeech || this.turnVoiced) return;
    voiceLog("voice", "turn.noise", { reason, ms: this.speechMs });
    this.inSpeech = false;
    this.stt.discard();
    this.updatePhase();
  }

  /**
   * This frame's levels (0..1) and the microphone's and the reply's spectrum and waveform, in the
   * shape Presence's wave (presence/callwave.js) reads; null while voice is off.
   */
  analysis(): {
    readonly levels: { readonly input: number; readonly output: number };
    readonly spectrum: VoiceSession["spectrum"];
  } | null {
    const player = this.player;
    if (this.context === null || this.input === null || player === null) return null;
    const spectrum = this.spectrum;
    spectrum.rate = this.context.sampleRate;
    this.input.getByteFrequencyData(spectrum.input);
    this.input.getFloatTimeDomainData(spectrum.inputWave);
    player.analyser.getByteFrequencyData(spectrum.output);
    player.analyser.getFloatTimeDomainData(spectrum.outputWave);
    return {
      levels: { input: Math.min(1, this.micLevel * 3), output: Math.min(1, player.voiceLevel() * 3) },
      spectrum,
    };
  }

  /** Drops a queued sentence that has not started playing (the hold line when the real one lands). */
  cancelQueued(text: string): boolean {
    const waiting = this.waiting.findIndex((sentence) => sentence.text === text);
    if (waiting >= 0) {
      this.waiting.splice(waiting, 1);
      return true;
    }
    return this.player?.drop(text) ?? false;
  }

  stopSpeaking(reason = "tap"): void {
    this.waiting = [];
    this.player?.stop(reason);
  }

  private onFrame(pcm: Int16Array, level: number): void {
    const player = this.player;
    if (player === null) return;
    const now = performance.now();
    if (this.muted) {
      for (const sentence of this.waiting)
        player.speak(sentence.text, sentence.topic, sentence.switching);
      this.waiting = [];
      this.releaseTopic(player, now);
      const replyAudible = player.speaking || now < player.audibleUntil + ECHO_TAIL_MS;
      this.sounds?.step(!replyAudible, false);
      return;
    }
    this.micLevel = level;
    const voiceNow = this.comb?.step(FRAME_MS) ?? false;
    if (voiceNow) this.lastVoiceAt = now;
    this.voiceLike = !this.combProven || now - this.lastVoiceAt < VOICE_HOLD_MS;
    if (this.waiting.length > 0 && !this.timHasTheFloor()) {
      this.dropNoiseTurn("a reply is ready");
      voiceLog("voice", "say.released", { sentences: this.waiting.length });
      this.sounds?.silence();
      for (const sentence of this.waiting)
        player.speak(sentence.text, sentence.topic, sentence.switching);
      this.waiting = [];
    }
    this.releaseTopic(player, now);
    // The reply is heard while it plays, between its sentences and for its echo's tail.
    const replyAudible = player.speaking || now < player.audibleUntil + ECHO_TAIL_MS;
    const mode: CloseTalkMode = replyAudible ? "speak" : this.thinking ? "think" : "listen";
    const decision =
      now < this.ignoreGateUntil
        ? null
        : this.gate.step(10 * Math.log10(level * level + 1e-12), mode, FRAME_MS);
    if (decision) this.floorDb = decision.floor;
    if (!this.gate.open || player.speaking) this.gateHasUser = false;
    if (decision?.opened || decision?.closed) {
      voiceLog("voice", decision.opened ? "gate.open" : "gate.close", {
        mode,
        by: decision.by,
        level: Math.round(decision.level),
        bar: Math.round(decision.bar),
        floor: Math.round(decision.floor),
        voice: Math.round(decision.voice),
      });
    }

    // The user's close voice over the reply: it goes quiet now; their words make it a stop, else it goes on.
    // Voiced is ~90 ms over the barge-in bar; a new hold needs a quiet moment since the last one.
    const close = this.gate.voiced || this.gate.open;
    if (!close) this.holdArmed = true;
    // The thinking pulse only into a quiet room: never with the user's turn, a reply or its echo. Only the user
    // holds it back afterwards: our reply's echo and plain noise also voice the gate, and counting
    // them kept the pulse off for the short thinking after a reply or "One moment.".
    // A noise turn is not their (3 Nov, walking: wind and steps opened one every 1.6 s, no pulse).
    this.sounds?.step(
      !(this.inSpeech && this.turnVoiced) &&
        !this.probing &&
        !replyAudible &&
        this.waiting.length === 0,
      close && this.voiceLike && !replyAudible,
    );
    // Against the reply's loudest moment in the last ~200 ms: its echo arrives late and rings on.
    this.replyDbs.push(20 * Math.log10(player.level() + 1e-9));
    if (this.replyDbs.length > 10) this.replyDbs.shift();
    const overReply =
      20 * Math.log10(level + 1e-9) >= Math.max(...this.replyDbs) - HOLD_OVER_REPLY_DB;
    this.overReplyMs = close && overReply && this.voiceLike ? this.overReplyMs + FRAME_MS : 0;
    if (decision?.opened && decision.by === "speak") this.closeVoiceAt = this.strongVoiceAt = now;
    if (
      this.overReplyMs >= HOLD_OVER_MS &&
      this.holdArmed &&
      replyAudible &&
      player.speaking &&
      !player.holding
    ) {
      if (this.stt.speechOnly) {
        this.holdArmed = false;
        this.holdAt = now;
        player.hold();
      }
    }
    if (player.holding) {
      if ((this.gate.open || this.gate.voiced) && this.voiceLike) this.heldVoiceAt = now;
      else if (this.heldVoiceAt < this.holdAt) this.heldVoiceAt = this.holdAt;
      if (now - this.heldVoiceAt >= HOLD_RELEASE_MS || now - this.holdAt >= HOLD_MAX_MS) {
        voiceLog("voice", "barge.released", { heldMs: Math.round(now - this.holdAt) });
        player.release();
      }
    }

    if (this.probing && !this.stt.speechOnly) {
      // Switched to a local service without voice detection mid-segment: nothing here counts.
      this.probing = false;
      this.stt.discard();
    }
    if (this.probing) {
      this.stt.push(pcm);
      this.probeMs += FRAME_MS;
      if (decision?.opened && decision.by === "speak") this.closeVoiceAt = now;
      // The reply ended while the user is talking (the user answers the moment the question ends): the segment
      // is their turn, not a probe (2 Nov: their "keep it" vanished three times between reply and turn).
      if (!replyAudible && (this.gate.open || this.gate.voiced) && this.voiceLike) {
        this.probeToTurn();
        return;
      }
      // A segment never ends while someone talks close: the user's interruption stays in one transcript.
      if (
        !replyAudible ||
        (this.probeMs >= PROBE_SEGMENT_MS && !this.gate.open && !this.gate.voiced) ||
        this.probeMs >= MAX_SEGMENT_MS
      ) {
        this.endProbe();
      }
      return;
    }

    if (!this.inSpeech) {
      this.preRoll.push(pcm);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      // During a reply the mic goes to speech-to-text only once the gate hears someone close (its
      // pre-roll keeps the onset): a quiet room sends nothing (the eval: 182 empty transcripts in 6 min).
      // During a reply only a transcript that is surely speech may cut it: local speech without its
      // voice detection turns breath and noise into "I'm sorry." (2 Nov: the user's replies cut off).
      if (replyAudible) {
        if ((this.gate.voiced || this.gate.open) && this.stt.speechOnly) this.beginProbe();
      } else if (decision?.opened || this.gate.open) {
        // Opened now, or already open from the reply's last moments: either way the user is talking.
        this.beginSpeech(false);
      }
      return;
    }

    this.stt.push(pcm);
    this.speechMs += FRAME_MS;
    if (voiceNow) this.turnVoiceMs += FRAME_MS;
    if (!this.turnVoiced && (voiceNow || !this.combProven)) this.markTurnVoiced();
    const loud =
      this.gate.open ||
      this.gate.voiced ||
      20 * Math.log10(level + 1e-9) >= this.floorDb + QUIET_OVER_FLOOR_DB;
    const heard = loud && this.voiceLike;
    if (heard && this.turnVoiced) this.heardUser(now);
    const carried = this.turnVoiced && this.gateHasUser && now - this.timHeardAt < GATE_CARRY_MS;
    this.closedMs = heard || carried ? 0 : this.closedMs + FRAME_MS;
    if (this.turnVoiced && this.closedMs === 0) this.timVoiceAt = now;
    const wait = endpointWait(this.partial);
    if (this.closedMs >= wait.ms) {
      if (!this.turnVoiced) return this.dropNoiseTurn("no voice");
      voiceLog("voice", "turn.end", {
        rule: wait.rule,
        quietMs: this.closedMs,
        voiceMs: this.turnVoiceMs,
        partial: this.partial,
      });
      this.inSpeech = false;
      this.finishUtterance();
      this.updatePhase();
    }
  }

  /**
   * While a reply plays, the mic streams in short segments; a reply stops only when the gate hears
   * The user close (in its speaking mode) and the segment's transcript has words that are their.
   */
  private beginProbe(): void {
    this.stt.warm();
    this.probing = true;
    this.probeMs = 0;
    this.rejectedInSegment = false;
    this.stt.discard();
    for (const frame of this.preRoll) this.stt.push(frame);
    this.preRoll = [];
  }

  private probeToTurn(): void {
    voiceLog("voice", "probe.to-turn", { ms: this.probeMs });
    this.probing = false;
    this.inSpeech = true;
    this.turnVoiced = true;
    this.turnVoiceMs = 0;
    this.startedDuringReply = false;
    this.utteranceStartedAt = performance.now() - this.probeMs;
    this.speechMs = this.probeMs;
    this.closedMs = 0;
    this.partial = "";
    this.partials = 0;
    this.updatePhase();
  }

  private strongVoice(): boolean {
    return this.gate.open || performance.now() - this.strongVoiceAt < BARGE_WINDOW_MS;
  }

  private closeVoiceRecently(): boolean {
    return this.gate.open || performance.now() - this.closeVoiceAt < BARGE_WINDOW_MS;
  }

  /** The comb heard the user in a turn with words: from now on loud without a voice is not them. */
  private proveComb(voiceMs: number): void {
    if (this.combProven || voiceMs < VOICE_PROOF_MS) return;
    this.combProven = true;
    voiceLog("voice", "voice-check.on", { voiceMs });
  }

  private heardUser(now: number): void {
    this.timHeardAt = this.timVoiceAt = now;
    this.gateHasUser = this.gate.open;
  }

  private markTurnVoiced(): void {
    this.turnVoiced = true;
    this.updatePhase();
  }

  private onPartial(text: string): void {
    if (this.inSpeech) {
      if (hasRealWords(text)) {
        this.proveComb(this.turnVoiceMs);
        if (!this.turnVoiced) this.markTurnVoiced();
      }
      // New words are the user still talking, whatever the level says.
      if (wordCount(text) > wordCount(this.partial)) {
        this.closedMs = 0;
        if (this.turnVoiced) this.heardUser(performance.now());
      }
      this.partial = text;
      this.partials += 1;
      return;
    }
    if (!this.probing) return;
    const spoken = this.player?.recentlySpoken() ?? [];
    if (this.player?.holding && this.strongVoice() && isTakeover(text, spoken)) {
      this.bargeIn("The user took over", text);
      return;
    }
    if (!isInterruption(text, spoken)) return;
    if (this.closeVoiceRecently()) {
      this.bargeIn("close voice and new words", text);
    } else if (!this.rejectedInSegment) {
      // Echo or room noise the recogniser turned into words: the gate heard nobody close.
      this.rejectedInSegment = true;
      voiceLog("voice", "barge.rejected", { reason: "words without a close voice", heard: text });
    }
  }

  /** The user is talking over the reply: stop it and keep the segment's audio as their utterance. */
  private bargeIn(reason: string, heard: string): void {
    voiceLog("voice", "barge.in", { reason, heard });
    this.player?.stop(`barge-in: ${reason}`);
    this.events.onStopped?.(reason);
    this.probing = false;
    this.inSpeech = true;
    this.turnVoiced = true;
    this.turnVoiceMs = 0;
    this.startedDuringReply = true;
    this.utteranceStartedAt = performance.now() - this.probeMs;
    this.speechMs = this.probeMs;
    this.closedMs = 0;
    this.partial = heard;
    this.partials = 1;
    this.updatePhase();
  }

  /** Closes a segment. Its final transcript can still show the user (partials lag); else it was echo. */
  private endProbe(): void {
    this.probing = false;
    const closeVoice = this.closeVoiceRecently();
    const strong = this.strongVoice();
    const ms = this.probeMs;
    void this.stt
      .commit({ fallback: false })
      .then((text) => {
        voiceLog("voice", "probe.segment", { ms, chars: text.trim().length, closeVoice });
        if (this.stream === null || text.trim() === "") return;
        const spoken = this.player?.recentlySpoken() ?? [];
        const takeover = Boolean(this.player?.holding) && strong && isTakeover(text, spoken);
        if (!takeover && !isInterruption(text, spoken)) return;
        if (!closeVoice) {
          voiceLog("voice", "barge.rejected", {
            reason: "words without a close voice",
            heard: text,
          });
          return;
        }
        voiceLog("voice", "barge.in", {
          reason: "close voice and new words (segment end)",
          heard: text,
        });
        this.player?.stop("barge-in: close voice and new words (segment end)");
        this.events.onStopped?.("close voice and new words");
        this.deliver(stripEcho(text, spoken), spoken, {
          speechMs: PROBE_SEGMENT_MS,
          duringReply: true,
        });
      })
      .catch(() => {});
  }

  private beginSpeech(duringReply: boolean): void {
    this.engine = speechEngine();
    this.stt.warm();
    this.inSpeech = true;
    this.turnVoiced = false;
    this.turnVoiceMs = 0;
    this.turnFollowsUser = performance.now() - this.timVoiceAt < FOLLOW_ON_MS;
    this.startedDuringReply = duringReply;
    this.utteranceStartedAt = performance.now() - this.preRoll.length * FRAME_MS;
    this.speechMs = 0;
    this.closedMs = 0;
    this.partial = "";
    this.partials = 0;
    this.stt.discard();
    for (const frame of this.preRoll) this.stt.push(frame);
    this.preRoll = [];
    this.updatePhase();
  }

  private finishUtterance(): void {
    const startedDuringReply = this.startedDuringReply;
    const speechMs = this.speechMs - this.closedMs;
    const partials = this.partials;
    const partial = this.partial;
    const startedAt = this.utteranceStartedAt;
    const voiceMs = this.turnVoiceMs;
    this.pendingTranscriptions += 1;
    // Noise that opened the gate has no words yet; a tick for it would sound like being heard.
    if (hasRealWords(partial)) this.blip();
    this.updatePhase();
    void this.stt
      .commit()
      .then((committed) => {
        const spoken = this.player?.recentlySpoken() ?? [];
        // The final transcript came back empty though the partials had words: they were heard
        // (2 Nov: the user's answer to "how much per day?" showed "Yeah, yeah." and then vanished).
        const fromPartial = committed.trim() === "" && hasRealWords(partial);
        if (fromPartial) voiceLog("user", "transcript.from-partial", { partial });
        const text = fromPartial ? partial : committed;
        // Without partials (the socket down, batch transcripts only) the final words prove it
        // (3 Nov: no partials for a whole call, the comb never came on and noise counted as the user).
        if (!startedDuringReply && hasRealWords(text)) this.proveComb(voiceMs);
        this.deliver(startedDuringReply ? stripEcho(text, spoken) : text, spoken, {
          speechMs,
          partials,
          startedAt,
          duringReply: startedDuringReply,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        voiceLog("system", "error", { where: "stt", engine: this.engine, message });
        this.events.onError(voiceErrorText(error));
      })
      .finally(() => {
        this.pendingTranscriptions -= 1;
        this.updatePhase();
      });
  }

  private deliver(
    transcript: string,
    spoken: ReadonlyArray<string>,
    info: {
      readonly speechMs: number;
      readonly partials?: number;
      readonly startedAt?: number;
      readonly duringReply: boolean;
    },
  ): void {
    const heard = asciiPunctuation(transcript)
      .replace(/^[\s.,;:!?…-]+/, "")
      .trim();
    const words = heard.split(/\s+/).filter(Boolean);
    const drop = !hasRealWords(heard)
      ? "no real words"
      : this.engine === "local" && isNoisePhrase(heard)
        ? "a phrase made up from noise"
        : isEchoOfSpoken(heard, spoken)
          ? "our own words coming back"
          : words.length === 1 && info.speechMs < MIN_LONE_WORD_MS
            ? "a lone word from a short noise"
            : null;
    const detail = {
      text: heard,
      engine: this.engine,
      speechMs: Math.round(info.speechMs),
      partials: info.partials ?? null,
      startedMsAgo: info.startedAt ? Math.round(performance.now() - info.startedAt) : null,
      duringReply: info.duringReply,
    };
    if (this.stream === null) return;
    if (drop !== null) {
      voiceLog("user", "utterance.dropped", { ...detail, reason: drop });
      return;
    }
    voiceLog("user", "utterance", detail);
    this.events.onUtterance(heard);
  }

  /** A soft tick the moment an utterance is captured, so the user hears the user was heard. */
  private blip(): void {
    const context = this.context;
    if (context === null) return;
    this.ignoreGateUntil = performance.now() + BLIP_IGNORE_MS;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(soundOutput(context));
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  }

  private updatePhase(): void {
    if (this.stream === null) return this.setPhase("off");
    if (this.inSpeech && this.turnVoiced) return this.setPhase("hearing");
    if (this.player?.speaking) return this.setPhase("speaking");
    if (this.pendingTranscriptions > 0) return this.setPhase("transcribing");
    this.setPhase("listening");
  }

  private setPhase(phase: VoicePhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.events.onPhase(phase);
  }
}
