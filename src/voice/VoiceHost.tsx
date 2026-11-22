import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ComponentProps, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { readFileAsDataUrl } from "~/lib/imageCompression";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import {
  useHarnessDown,
  useHarnessLink,
  useProjects,
  useThreadShells,
  useThreadVisibleTurnItems,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerSettingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useVoiceBrainContext } from "../state/voiceBrainContext";
import { uploadVoiceFile } from "../state/voiceUpload";
import { brainFileReader } from "./adapters";
import { applyCardTags, takeCards } from "./brainCards";
import { compactEstimateMs, compactionDue, shareBrainThread } from "./brainCompaction";
import { markBriefed, needsBrief, withBrief, withCanvas } from "./brief";
import { prewarm, speechProgress, speechStatus } from "./browserSpeech/browser";
import { afterCanvasShown } from "./canvasShown";
import {
  followCommand,
  isFollowing,
  isFollowLabEnabled,
  setFollowing,
  subscribeFollow,
  takeAboutCards,
  takeFocus,
} from "./follow";
import { settleBrainThread } from "./settleThread";
import { type VoicePhase, VoiceSession } from "./speech";
import { takeSentences } from "./speechText";
import { setCallLive } from "./phoneUpdate";
import { VoiceBar, type VoiceBarModel, type VoiceBarState } from "./VoiceBar";
import type { VoiceFileRef } from "./VoiceInput";
import { closeVoiceSettings, CONNECTED_HOLD_MS, onVoiceSettingsClosed, openVoiceSettings } from "./VoiceSettings";
import { endVoiceLogSession, startVoiceLogSession, voiceLog } from "./voiceLog";
import {
  isGatewayStatus,
  NOT_SENT_TEXT,
  BRAIN_RETRY_TEXT,
  OFFLINE_TEXT,
  REQUEST_TIMEOUT_MS,
  UNREACHABLE_TEXT,
  voiceErrorText,
} from "./voiceErrors";
import { checkLink, linkIsDown, markLinkDown, onLinkUp, useLinkDown } from "./voiceLink";
import { autoStartCall, replyVoice, useAutoStartCall } from "./settingsStore";
import { connectPreview } from "./connectPreview";
import { type HeldWords, heldWords, holdWords, releaseWords, useHeldCount } from "./voiceOutbox";
import { syncVoiceTheme } from "./voiceThemeSync";
import { setStreamerMode } from "./streamerMode";
import {
  ANY_HEARD_TAG,
  forgetSpoken,
  inboxCallStarted,
  replyFinished,
  reportPresent,
  trackSpoken,
} from "./inbox/store";

// A LALALA_MODEL test run gets its own thread, so it never becomes the user's voice thread.
const voiceThreadTitle = (config: VoiceConfig | null) =>
  config?.model ? `voice test (${config.model})` : "voice";
// Thinking shows only after the user has been quiet this long, so a pause never reads as done.
const THINKING_AFTER_QUIET_MS = 1_500;
// From the user's words until the thread shows its run, so the send's round trip never flashes listening.
const AWAIT_RUN_MS = 3_000;
// What the brain says or thinks; anything else in its turn (a command, a search, a file) is work.
const TALK_ITEMS = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "notification",
  "system_notice",
  "checkpoint",
]);
const MODELS_READ_EVERY_MS = 250;
const RECONNECT_EVERY_MS = 2_000;
/** The brain puts this before outside material, at the start or after its answer to the user (brain.md). */
const NEW_TOPIC_TAG = /\s*\[new topic\]\s*/gi;
// The marker becomes a paragraph break plus this invisible mark, so the material after it is its
// own sentence and the topic sound plays right before it.
const TOPIC_MARK = "\u2063";
// An update about a card the user is looking at (`[new topic] [about: <id>]`): it still waits for their
// turn to end, but plays as plain speech, without the UPDATE takeover and its sound. Same length as
// TOPIC_MARK, so offsets into the text hold whichever way it was decided.
const QUIET_TOPIC_MARK = "\u2064";
const ABOUT_TOPIC_TAG = /\s*\[new topic\]\s*\[about:\s*([^\]]*)\]\s*/gi;
const ABOUT_TAG = /\s*\[about:[^\]]*\]\s*/gi;
const opensTopic = (text: string) => /^\s*[\u2063\u2064]/.test(text);
// `[tidy]` repacks the open canvas, `[tidy: <group name>]` only that group.
const TIDY_TAG = /\[tidy(?::\s*([^\]]*))?\]\s*/gi;
// `[settle]` settles the current brain thread in T3 Code.
const SETTLE_TAG = /\[settle\]\s*/gi;
// A call whose mic another tab or app holds tries again this often until it opens.
const MIC_RETRY_MS = 4_000;
const MIC_IN_USE = /microphone is in use/i;
// `[streamer: on]` / `[streamer: off]` flips streamer mode, the same switch as in settings.
const STREAMER_TAG = /\[streamer:\s*(on|off)\s*\]\s*/gi;
// A sent `/compact` counts as running this long at most, until its run shows on the thread.
const COMPACT_SHOWS_MS = 10_000;

// Pictures go inside the send as data URLs, so a send with them may take longer.
const SEND_WITH_IMAGES_TIMEOUT_MS = 30_000;
// Tries for one held message while lalala answers (1, 2, 4, 8, 16 s apart); offline doesn't count.
const SEND_TRIES = 6;
const sendBackoffMs = (tries: number) => Math.min(16_000, 1_000 * 2 ** (tries - 1));

type SendOutcome =
  | { readonly sent: true }
  | {
      readonly sent: false;
      readonly retry: boolean;
      readonly message: string;
      readonly timedOut?: boolean;
    };

type VoiceConfig = {
  readonly workspaceRoot: string;
  /** LALALA_MODEL: a model for new voice threads instead of the default model's. */
  readonly model: string | null;
};

/**
 * lalala: a hands-free conversation with the brain thread (LALALA_THREAD_ID). The user's
 * words go to that thread as turns, its finished replies are spoken back, and the thread (a normal
 * agent with T3's tools) acts on the instance or edits this UI. Ctrl+Option+V toggles the mic.
 */
declare global {
  /** The bar's typed send, for cards (extras/ may not import the host): true once the words are held. */
  var __lalalaSendTyped: ((text: string) => Promise<boolean>) | undefined;
}

export function VoiceHost({
  bar,
  autoStart = false,
}: {
  readonly bar?: Partial<ComponentProps<typeof VoiceBar>>;
  /** Starts the call as soon as the voice is set up (lalala.talk, right after pairing). */
  readonly autoStart?: boolean;
} = {}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const shells = useThreadShells();
  const link = useHarnessLink();
  const down = useHarnessDown();
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [quiet, setQuiet] = useState(true);
  const quietTimerRef = useRef<number | null>(null);
  const [awaitingRun, setAwaitingRun] = useState(false);
  const awaitTimerRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Between the tap and a live microphone (permission, speech socket): Presence's connecting look.
  const [starting, setStarting] = useState(false);
  // When the user last cut a reply off; the bar shows Presence's stopped look.
  const [stoppedAt, setStoppedAt] = useState(0);
  // The user's mic is muted for this call (the bar's mic cell); the call and its replies go on.
  const [muted, setMuted] = useState(false);
  // The platform took the mic away mid-call (iOS: another app playing sound); a tap takes it back.
  const [micPaused, setMicPaused] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const micRetryRef = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the busy mic's quiet retry (a browser timer) when the host goes away
  useEffect(() => () => window.clearTimeout(micRetryRef.current), []);
  // A tap while the mic opens would start a second session that nothing ever stops (13 Nov).
  const startingRef = useRef(false);
  const sessionStartedAtRef = useRef(0);
  // When the user's last words went to the thread (performance time), for the log's reply timings.
  const sentAtRef = useRef(0);
  /** The send's wall time, to tell this turn's items from the previous turn's. */
  const sentEpochRef = useRef(0);
  /** The brain started a tool in this turn (it will be slow). */
  const workStartedRef = useRef(false);
  const firstTextLoggedRef = useRef(false);
  // How much of each reply has been queued for speech, by turn item id.
  const spokenRef = useRef(new Map<string, number>());
  // Replies already spoken to the end: never read again, since the offsets above are into the
  // stripped text and a hot reload that changes the stripping left them pointing at old tails.
  const finishedRef = useRef(new Set<string>());
  // Focus tags already applied, by turn item id; and whether the user asked to be shown something.
  const focusedRef = useRef(new Map<string, number>());
  const passiveFollowedRef = useRef<Map<string, number> | null>(null);
  const tidiedRef = useRef(new Set<string>());
  const settledRef = useRef(new Set<string>());
  // How many `[new topic]` parts of each reply have started, by turn item id.
  const topicPartsRef = useRef(new Map<string, number>());
  // Per `[about: …]` update (reply id and its index): whether its card was on screen when it arrived.
  const quietTopicsRef = useRef(new Map<string, boolean>());
  // The user's latest words: a reply after them on the thread is their answer.
  const awaitedMessageRef = useRef<string | null>(null);
  // The thread this client just created, until its shell arrives.
  const pendingThreadIdRef = useRef<ThreadId | null>(null);
  // The page can't reach lalala: the user's words wait in the outbox (voiceOutbox) until it can.
  const linkDown = useLinkDown();
  const heldCount = useHeldCount();
  const drainingRef = useRef(false);
  // The outbox gave up on the oldest held words; the bar says so and a tap sends them again.
  const [notSent, setNotSent] = useState(false);

  const project = projects.find(
    (candidate) =>
      candidate.environmentId === environmentId &&
      config !== null &&
      candidate.workspaceRoot === config.workspaceRoot,
  );
  const voiceThread = shells
    .filter(
      (shell) =>
        project !== undefined &&
        shell.environmentId === project.environmentId &&
        shell.projectId === project.id &&
        shell.title === voiceThreadTitle(config) &&
        shell.archivedAt === null &&
        shell.deletedAt === null,
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const voiceThreadRef = voiceThread
    ? scopeThreadRef(voiceThread.environmentId, voiceThread.id)
    : null;
  // lalala.talk: the harness and speech adapters stand in for the dev server and the speech service.
  const harness = globalThis.__lalalaAdapters?.harness;
  const following = useSyncExternalStore(subscribeFollow, isFollowing, () => false);
  // Out of a call too where follow is on or the brain's replies carry cards (brainCards.ts).
  const items = useThreadVisibleTurnItems(
    phase === "off" && !following && !brainFileReader() ? null : voiceThreadRef,
  );
  const thinking = threadRuntimeIsActive(voiceThread?.runtime);
  const brainContext = useVoiceBrainContext(voiceThreadRef);
  // When this page sent a `/compact`, until its run shows or ends; and the usage it compacted.
  const [compactSentAt, setCompactSentAt] = useState<number | null>(null);
  const compactedForRef = useRef<number | null>(null);
  // The user's words that wait for the compaction, so they and the brief land after it.
  const compactWaitersRef = useRef<Array<() => void>>([]);
  // The `/compact` on its way to T3, so words spoken meanwhile wait for it too.
  const compactSendingRef = useRef<Promise<boolean> | null>(null);
  const compacting =
    brainContext?.compacting === true ||
    (compactSentAt !== null && (brainContext?.compactedAt ?? 0) < compactSentAt);
  // A compaction is the thread's run too, but no reply: the call waits through it, with the bar's
  // defrag and no thinking pulse (Tim, 16 Nov: the pulse looped through a whole /compact).
  const replying = thinking && !compacting;
  // The provider failing and retrying its request (16 Nov: eight retries, 105 s of a looping pulse
  // in Tim's demo): the bar says so instead of thinking.
  const brainRetrying = thinking && items.some(({ item }) => item.retrying === true);

  // The in-browser models' download and warm-up (the bar's readout); null once ready.
  const [loading, setLoading] = useState<ReadonlyArray<VoiceBarModel> | null>(null);
  // Why the reply voice is still not loaded while it tries again (never quiet on "voice loading").
  const [voiceLoadError, setVoiceLoadError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the speech models' workers (outside React) once the canvas is shown, so a call finds them ready
  useEffect(() => {
    // The connect preview is a picture of lalala.talk before pairing: no speech to load.
    if (config === null || connectPreview) return;
    return afterCanvasShown(prewarm);
  }, [config]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the dev server's voice config once
  useEffect(() => {
    let cancelled = false;
    (harness
      ? harness.config()
      : fetch("/__lalala/config", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then((response) =>
          response.ok ? (response.json() as Promise<VoiceConfig>) : null,
        ))
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the in-browser models' load state (workers outside React) while a call loads them, and stops once they are ready
  useEffect(() => {
    if (phase === "off" && !starting) return;
    let timer = 0;
    const read = () => {
      const models = speechProgress();
      setLoading(models);
      setVoiceLoadError(models === null ? null : (speechStatus("voice")?.error ?? null));
      if (models === null) window.clearInterval(timer);
    };
    timer = window.setInterval(read, MODELS_READ_EVERY_MS);
    read();
    return () => window.clearInterval(timer);
  }, [phase, starting]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls lalala while the bar says it is unreachable, and clears that once it answers again
  useEffect(() => {
    if (error !== UNREACHABLE_TEXT) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      (harness
        ? harness.config().then(() => true)
        : fetch("/__lalala/config", {
            cache: "no-store",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }).then((response) => response.ok)
      )
        .then((ok) => {
          if (!cancelled && ok) setError((now) => (now === UNREACHABLE_TEXT ? null : now));
        })
        .catch(() => {});
    }, RECONNECT_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [error, harness]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs the brain-edited theme file as T3's "Voice" theme
  useEffect(() => syncVoiceTheme(), []);

  /**
   * T3's "compact when you return": a big brain context whose cache went cold compacts before
   * the user's next words. True while a compaction runs, so the caller waits for it.
   */
  const compactIfDue = useEffectEvent(async (why: string): Promise<boolean> => {
    if (compacting) return true;
    if (compactSendingRef.current !== null) return compactSendingRef.current;
    if (environmentId === null || voiceThread === undefined || thinking) return false;
    if (brainContext === null || !compactionDue(brainContext, Date.now())) return false;
    if (compactedForRef.current === brainContext.reportedAt) return false;
    compactedForRef.current = brainContext.reportedAt;
    const tokens = brainContext.usedTokens;
    const sending = (async () => {
      const sentAt = Date.now();
      voiceLog("system", "compact", { why, tokens });
      const result = await startTurn({
        environmentId,
        input: {
          threadId: voiceThread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "/compact",
            attachments: [],
            idleCompaction: "onReturn",
          },
          runtimeMode: voiceThread.runtimeMode,
          interactionMode: voiceThread.interactionMode,
          createdAt: new Date(sentAt).toISOString(),
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        voiceLog("system", "error", { where: "compact", message: String(failure) });
        return false;
      }
      setCompactSentAt(sentAt);
      window.setTimeout(
        () => setCompactSentAt((current) => (current === sentAt ? null : current)),
        COMPACT_SHOWS_MS,
      );
      return true;
    })();
    compactSendingRef.current = sending;
    return sending.finally(() => {
      compactSendingRef.current = null;
    });
  });

  const brainKnown = brainContext !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- compacts a big, cold brain when the page opens (T3's "compact when you return")
  useEffect(() => {
    if (brainKnown) void compactIfDue("page open");
  }, [brainKnown]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lets the user's words that waited for a compaction go once it ended
  useEffect(() => {
    if (compacting) return;
    for (const resolve of compactWaitersRef.current.splice(0)) resolve();
  }, [compacting]);

  const brainThreadId = voiceThread?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the settings sheet (rendered by the bar, without the thread) which thread is the brain
  useEffect(() => {
    shareBrainThread(
      environmentId === null || brainThreadId === null
        ? null
        : scopeThreadRef(environmentId, brainThreadId),
    );
  }, [environmentId, brainThreadId]);

  /** The user's words join the outbox, which sends them in order; true once they are held. */
  const send = (
    text: string,
    images: ReadonlyArray<File> = [],
    files: ReadonlyArray<VoiceFileRef> = [],
  ) => {
    const unheard = sessionRef.current?.timSpoke(text) ?? [];
    reportPresent();
    awaitedMessageRef.current = holdWords(text, images, files, unheard).messageId;
    if (linkIsDown()) voiceLog("user", "held", { text, held: heldWords().length });
    setNotSent(false);
    void drain();
    return true;
  };

  /**
   * Sends the held words oldest first, each after a compaction that is due or running (its turn
   * re-reads less). Offline they wait for the link; a failure while lalala answers retries with
   * backoff, then the bar says they weren't sent and a tap tries again.
   */
  const drain = useEffectEvent(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      let tries = 0;
      for (let words = heldWords()[0]; words !== undefined; words = heldWords()[0]) {
        if (linkIsDown()) return;
        if (await compactIfDue("send")) {
          await new Promise<void>((resolve) => compactWaitersRef.current.push(resolve));
        }
        const outcome = await sendNow(words);
        if (outcome.sent) {
          releaseWords(words.id);
          tries = 0;
          continue;
        }
        tries += 1;
        voiceLog("system", "send.failed", {
          text: words.text,
          tries,
          message: outcome.message,
          heldMs: Date.now() - words.at,
          held: heldWords().length,
        });
        if (!outcome.retry) return;
        // No answer at all is the outage itself; an answered failure asks whether lalala is there.
        if (outcome.timedOut) {
          markLinkDown("send timed out");
          return;
        }
        if (!(await checkLink("send failed"))) return;
        if (tries >= SEND_TRIES) {
          voiceLog("system", "send.gave-up", { text: words.text, tries, held: heldWords().length });
          setNotSent(true);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, sendBackoffMs(tries)));
      }
    } finally {
      drainingRef.current = false;
    }
  });

  /** The user's words (spoken, or typed in the bar's input with its pictures and uploaded files) as a turn on the voice thread, made on first use. */
  const sendNow = useEffectEvent(
    async ({
      text,
      images,
      files,
      messageId,
      commandId,
      unheard,
    }: HeldWords): Promise<SendOutcome> => {
      if (environmentId === null || project === undefined) {
        setError("No brain thread yet: pair with T3 Code in the settings.");
        return { sent: false, retry: false, message: "no brain thread" };
      }
      const defaultSelection = serverSettings.defaultModelSelection;
      const modelSelection =
        defaultSelection !== null && config?.model
          ? // Same instance and options (effort) as the default; only the model differs.
            { ...defaultSelection, model: config.model }
          : defaultSelection;
      const createdAt = new Date().toISOString();
      // The data-URL form startTurn persists itself (the composer's path without upload URLs).
      const attachments = await Promise.all(
        images.map(async (file) => ({
          type: "image" as const,
          id: randomUUID(),
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          dataUrl: await readFileAsDataUrl(file),
        })),
      );
      const message = {
        messageId,
        role: "user" as const,
        attachments: [...attachments, ...files],
      };
      const existingThreadId = voiceThread?.id ?? pendingThreadIdRef.current;
      if (existingThreadId === null && modelSelection === null) {
        setError("Pick a default model in Settings first.");
        return { sent: false, retry: false, message: "no default model" };
      }
      const threadId = existingThreadId ?? newThreadId();
      if (existingThreadId === null) pendingThreadIdRef.current = threadId;
      const follow = followCommand(text);
      if (follow === false || (follow === true && isFollowLabEnabled())) setFollowing(follow);
      const briefed =
        existingThreadId === null || needsBrief(threadId, items, brainContext?.compactedAt ?? null);
      const tagged = withCanvas(text, unheard);
      const turnMessage = briefed ? withBrief(tagged) : { text: tagged };
      // A send queued on a dead connection never fails on its own; it counts as failed after this.
      let timer = 0;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = window.setTimeout(
          () => resolve("timeout"),
          images.length > 0 ? SEND_WITH_IMAGES_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        );
      });
      const turn =
        existingThreadId !== null || modelSelection === null
          ? startTurn({
              environmentId,
              input: {
                commandId,
                threadId,
                message: { ...message, ...turnMessage },
                runtimeMode: voiceThread?.runtimeMode ?? "full-access",
                interactionMode: voiceThread?.interactionMode ?? "default",
                createdAt,
              },
            })
          : startTurn({
              environmentId,
              input: {
                commandId,
                threadId,
                message: { ...message, ...turnMessage },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title: voiceThreadTitle(config),
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                },
                createdAt,
              },
            });
      const result = await Promise.race([turn, timedOut]).finally(() => window.clearTimeout(timer));
      if (result === "timeout" || result._tag === "Failure") {
        if (existingThreadId === null) pendingThreadIdRef.current = null;
        const failure = result === "timeout" ? null : squashAtomCommandFailure(result);
        // The standalone's send aborts itself after the same time (a TimeoutError).
        if (
          result === "timeout" ||
          (failure instanceof DOMException && failure.name === "TimeoutError")
        ) {
          return { sent: false, retry: true, message: "send timed out", timedOut: true };
        }
        return { sent: false, retry: true, message: voiceErrorText(failure) };
      }
      if (briefed) markBriefed(threadId);
      voiceLog("user", "send", {
        text,
        unheard: unheard.length,
        briefed,
        threadId,
        images: images.length,
        files: files.length,
      });
      sentAtRef.current = performance.now();
      sentEpochRef.current = Date.now();
      workStartedRef.current = false;
      firstTextLoggedRef.current = false;
      return { sent: true };
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the held words when the link (voiceLink, outside React) comes back
  useEffect(() => onLinkUp(() => void drain()), []);

  // Words held before a reload go once the voice thread is known (sooner, a new thread would start).
  const voiceThreadKnown = voiceThread !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends words a reload left in the outbox (sessionStorage) once the thread is there
  useEffect(() => {
    if (voiceThreadKnown && heldWords().length > 0) void drain();
  }, [voiceThreadKnown]);

  const toggle = useEffectEvent(async (quiet = false) => {
    if (startingRef.current) return;
    // A call started by hand ends auto start's wait for a tap.
    if (!sessionRef.current?.active) disarmAutoStartRef.current?.();
    const current = sessionRef.current;
    // A tap on the paused bar brings the mic back; it never hangs up.
    if (current?.active && current.micPausedForTap) {
      current.revive();
      return;
    }
    // While a reply plays, a tap only stops the reply; on a phone its speaker sits next to the mic.
    if (current?.active && phase === "speaking") {
      current.stopSpeaking("tap");
      setStoppedAt(Date.now());
      return;
    }
    if (current?.active) {
      current.stop();
      sessionRef.current = null;
      setMuted(false);
      forgetSpoken();
      endVoiceLogSession("mic off (tap)");
      return;
    }
    window.clearTimeout(micRetryRef.current);
    // A quiet retry keeps the message up until the call really starts.
    if (!quiet) setError(null);
    const session = new VoiceSession({
      onPhase: (next) => {
        setPhase(next);
        if (quietTimerRef.current !== null) window.clearTimeout(quietTimerRef.current);
        quietTimerRef.current = null;
        if (next === "hearing") {
          setError(null);
          setQuiet(false);
          return;
        }
        // From the user's last voice, not this change (transcribing then listening flipped the bar back
        // to listening), checked again when due: their turn can end while the user still talks (3 Nov).
        const settle = () => {
          const left = THINKING_AFTER_QUIET_MS - (performance.now() - session.lastUserVoiceAt);
          quietTimerRef.current = left > 0 ? window.setTimeout(settle, left) : null;
          setQuiet(left <= 0);
        };
        settle();
      },
      onUtterance: (text) => {
        setAwaitingRun(true);
        if (awaitTimerRef.current !== null) window.clearTimeout(awaitTimerRef.current);
        awaitTimerRef.current = window.setTimeout(() => setAwaitingRun(false), AWAIT_RUN_MS);
        void send(text);
      },
      onError: (message) => {
        voiceLog("system", "error", { where: "voice", message });
        setError(message);
      },
      onStopped: () => setStoppedAt(Date.now()),
      onMicPaused: setMicPaused,
    });
    startVoiceLogSession({ voice: replyVoice(), thread: voiceThread?.id ?? null });
    inboxCallStarted();
    sessionRef.current = session;
    sessionStartedAtRef.current = Date.now();
    setCallLive(true);
    setStarting(true);
    startingRef.current = true;
    void compactIfDue("call start");
    try {
      await session.start();
      // Muted before the call: it starts muted.
      if (muted) session.setMuted(true);
    } catch (cause) {
      // Whatever the start opened (the audio context, a mic it did get) is let go at once.
      session.stop();
      sessionRef.current = null;
      const message = voiceErrorText(cause);
      setError(message);
      // The mic is busy elsewhere: try again quietly until it's free, no tap needed.
      if (MIC_IN_USE.test(message)) {
        micRetryRef.current = window.setTimeout(() => {
          if (sessionRef.current !== null) return;
          if (document.visibilityState === "visible") void toggle(true);
          else document.addEventListener("visibilitychange", () => void toggle(true), { once: true });
        }, MIC_RETRY_MS);
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the session while the brain works, so the user needs a little more to cut in (Presence's think bar)
  useEffect(() => {
    sessionRef.current?.setThinking(replying);
  }, [replying]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the cards and templates named in the brain's finished replies on the canvas
  useEffect(() => {
    const readFile = brainFileReader();
    if (voiceThread) applyCardTags(voiceThread.id, items, readFile);
  }, [items, voiceThread?.id]);

  // Passive follow: when Follow is on, focus cards named by incoming `[focus: …]` or `[about: …]`
  // tags even when voice is OFF (e.g. on a big screen). Seeds existing history on first snapshot so
  // reloading or re-enabling Follow never jumps to an old message.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the canvas camera in response to incoming brain messages while follow is enabled
  useEffect(() => {
    if (!following) {
      passiveFollowedRef.current = null;
      return;
    }
    if (items.length === 0) return;
    if (passiveFollowedRef.current === null) {
      const seed = new Map<string, number>();
      for (const { item } of items) {
        if (item.type !== "assistant_message" || item.parentItemId !== null) continue;
        const count = takeFocus(item.text).cards.length + takeAboutCards(item.text).length;
        seed.set(item.id, count);
      }
      passiveFollowedRef.current = seed;
      return;
    }
    const seen = passiveFollowedRef.current;
    for (const { item, visibility } of items) {
      if (item.type !== "assistant_message" || visibility !== "local") continue;
      if (item.parentItemId !== null) continue;
      const focusCards = takeFocus(item.text).cards;
      const aboutCards = takeAboutCards(item.text);
      const total = focusCards.length + aboutCards.length;
      const prev = seen.get(item.id) ?? 0;
      if (total <= prev) continue;
      seen.set(item.id, total);
      // During an active call, `[focus:]` is handled by the voice loop below; passive follow still
      // covers `[about:]` updates and any `[focus:]` when voice is off.
      const card =
        sessionRef.current === null
          ? (focusCards.at(-1) ?? aboutCards.at(-1))
          : aboutCards.at(-1);
      if (card) {
        voiceLog("brain", "follow.focus", {
          card,
          via: sessionRef.current === null ? "passive" : "about",
        });
        globalThis.__lalalaCanvases?.focus?.(card, false);
      }
    }
  }, [items, following]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- speaks the voice thread's replies sentence by sentence as they stream while the mic is on
  useEffect(() => {
    const session = sessionRef.current;
    if (session === null) return;
    // The user's latest words on the thread (by message id; an older bridge's rows carry none).
    const awaited = awaitedMessageRef.current;
    const asked =
      awaited === null
        ? undefined
        : items.findLast(
            ({ item }) =>
              item.type === "user_message" && (item.messageId ?? awaited) === awaited,
          )?.item;
    // By the server's start times: the bridge's rows come in update order.
    const askedAt = asked ? DateTime.toEpochMillis(asked.startedAt ?? asked.updatedAt) : undefined;
    for (const { item, visibility } of items) {
      const startedAt = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
      const thisTurn = sentEpochRef.current > 0 && startedAt >= sentEpochRef.current - 500;
      if (thisTurn && !TALK_ITEMS.has(item.type)) workStartedRef.current = true;
      if (item.type !== "assistant_message" || visibility !== "local") continue;
      if (item.parentItemId !== null) continue;
      if (startedAt < sessionStartedAtRef.current - 1_000) continue;
      // Focus tags move the canvas and are never spoken, nor is the brain's `[new topic]` marker.
      const tidies = [...item.text.matchAll(TIDY_TAG)].map((m) =>
        (m[1] ?? "").replace(/[`"]/g, "").trim(),
      );
      const wantsSettle = SETTLE_TAG.test(item.text);
      SETTLE_TAG.lastIndex = 0;
      // Whether an update is about a card on screen is decided once, when its tag first arrives.
      let abouts = 0;
      const marked = takeCards(item.text)
        .text
        // The away inbox's `[heard: …]` is never spoken (inbox/store.ts).
        .replace(ANY_HEARD_TAG, " ")
        .replace(ABOUT_TOPIC_TAG, (_tag, card: string) => {
          const key = `${item.id}#${abouts++}`;
          let quiet = quietTopicsRef.current.get(key);
          if (quiet === undefined) {
            quiet = globalThis.__lalalaCanvases?.inView?.(card) ?? false;
            quietTopicsRef.current.set(key, quiet);
            voiceLog("brain", "update.about", { card, inView: quiet });
          }
          return `\n\n${quiet ? QUIET_TOPIC_MARK : TOPIC_MARK}`;
        })
        .replace(NEW_TOPIC_TAG, `\n\n${TOPIC_MARK}`)
        .replace(ABOUT_TAG, " ")
        .replace(TIDY_TAG, "")
        .replace(SETTLE_TAG, "")
        .replace(STREAMER_TAG, "");
      const streamer = [...item.text.matchAll(STREAMER_TAG)].at(-1)?.[1]?.toLowerCase();
      if (thisTurn && streamer) setStreamerMode(streamer === "on");
      const { text, cards } = takeFocus(marked);
      if (thisTurn && tidies.length > 0 && !tidiedRef.current.has(item.id)) {
        tidiedRef.current.add(item.id);
        const canvases = globalThis.__lalalaCanvases;
        for (const group of tidies) {
          if (group === "") canvases?.tidy?.();
          else voiceLog("brain", "tidy.group", { group, found: canvases?.tidyGroup?.(group) });
        }
        if (tidies.includes("")) voiceLog("brain", "tidy", {});
      }
      if (thisTurn && wantsSettle && !settledRef.current.has(item.id)) {
        settledRef.current.add(item.id);
        void settleBrainThread("brain");
      }
      const focused = focusedRef.current.get(item.id) ?? 0;
      if (thisTurn && cards.length > focused) {
        focusedRef.current.set(item.id, cards.length);
        const card = cards.at(-1);
        // The brain adds a focus tag only when follow is on or the user asked to see a card; a regex
        // over the transcript missed "shout me" and "follow the card", so its tag is trusted.
        if (card) {
          voiceLog("brain", "focus", { card });
          globalThis.__lalalaCanvases?.focus?.(card, false);
        }
      }
      if (finishedRef.current.has(item.id)) continue;
      const queued = spokenRef.current.get(item.id) ?? 0;
      if (queued >= text.length && item.streaming) continue;
      // Only this turn's reply: the previous turn's finished one is still in the list (eval 2 Nov:
      // first-text read 1 ms after every send).
      if (!firstTextLoggedRef.current && text.length > 0 && thisTurn) {
        firstTextLoggedRef.current = true;
        voiceLog("brain", "first-text", {
          msSinceSend: Math.round(performance.now() - sentAtRef.current),
          streaming: item.streaming,
        });
      }
      const { sentences, consumed } = takeSentences(text.slice(queued), !item.streaming);
      spokenRef.current.set(item.id, queued + consumed);
      for (const [index, sentence] of sentences.entries()) {
        voiceLog("brain", "sentence", {
          text: sentence,
          streaming: item.streaming,
          msSinceSend:
            sentAtRef.current > 0 ? Math.round(performance.now() - sentAtRef.current) : null,
        });
        const switching = opensTopic(sentence);
        const quiet = sentence.trimStart().startsWith(QUIET_TOPIC_MARK);
        const opensReply = (queued === 0 && index === 0) || switching;
        // What follows a `[new topic]` waits while the user's turn is open (topicHold); the rest answers them.
        const parts = (topicPartsRef.current.get(item.id) ?? 0) + (switching ? 1 : 0);
        topicPartsRef.current.set(item.id, parts);
        const part = parts > 0 ? `${item.id}#${parts}` : undefined;
        const spoken = session.speak(
          sentence.replaceAll(TOPIC_MARK, "").replaceAll(QUIET_TOPIC_MARK, ""),
          opensReply,
          switching && !quiet,
          part,
        );
        trackSpoken(item.id, spoken);
      }
      if (item.streaming) continue;
      finishedRef.current.add(item.id);
      replyFinished(item.id, item.text);
      // A finished reply after their words that doesn't open on `[new topic]` is their answer ("..." too).
      if (askedAt !== undefined && startedAt >= askedAt && !opensTopic(text)) {
        session.answered();
      }
    }
  }, [items]);

  const autoStartedRef = useRef(false);
  const disarmAutoStartRef = useRef<(() => void) | null>(null);
  // On applies from the next time lalala opens (read as it opens); off applies at once.
  const [autoStartAtOpen] = useState(autoStartCall);
  const autoStartLive = useAutoStartCall();
  const autoStartPicked = autoStartAtOpen && autoStartLive;
  const [tapToStart, setTapToStart] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the call once its config (read from the harness) is in; where the browser holds sound back until a gesture, the first tap anywhere does
  useEffect(() => {
    if ((!autoStart && !autoStartPicked) || config === null || autoStartedRef.current) return;
    if (sessionRef.current?.active) return;
    autoStartedRef.current = true;
    // Safari, phones and a Chrome tab that hasn't played sound here start audio only inside a gesture:
    // a fresh AudioContext says so ("suspended"); Firefox turns a permitted one "running" a tick later.
    const probe = new AudioContext();
    // pointerup is the gesture on iOS 13+ too; a scroll cancels the pointer instead of lifting it.
    const events = ["pointerdown", "pointerup", "pointercancel", "keydown"] as const;
    let waiting = true;
    let downAt: { x: number; y: number } | null = null;
    const begin = (how: string) => {
      if (!waiting) return;
      waiting = false;
      for (const type of events) document.removeEventListener(type, onGesture, true);
      void probe.close();
      setTapToStart(false);
      voiceLog("system", "auto-start", { how });
      if (how !== "started" && !sessionRef.current?.active) void toggle();
    };
    // A real tap or Enter/Space starts it; Tab, Escape, modifiers and taps on buttons, links or the
    // settings sheet keep waiting (the gear must still open Settings to turn auto start off).
    function onGesture(event: Event) {
      // START itself was pressed meanwhile: nothing left to wait for.
      if (sessionRef.current?.active || startingRef.current) return begin("started");
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      }
      // A right click or a middle click opens menus, and a finger that moved was scrolling.
      if (event instanceof PointerEvent) {
        if (event.type === "pointercancel") return void (downAt = null);
        if (event.button !== 0) return;
        if (event.type === "pointerdown") return void (downAt = { x: event.clientX, y: event.clientY });
        const from = downAt;
        downAt = null;
        if (from === null || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 10) return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a, input, select, textarea, [role='dialog'], [data-lalala-settings]"))
        return;
      begin("tap");
    }
    // Pressing START meanwhile clears the wait at once (toggle calls it).
    disarmAutoStartRef.current = () => begin("started");
    if (probe.state === "running") begin("allowed");
    else {
      setTapToStart(true);
      probe.onstatechange = () => probe.state === "running" && begin("allowed");
      for (const type of events) document.addEventListener(type, onGesture, true);
    }
    return () => {
      // Auto start turned off (or the host left) while it waited: nothing starts; on again re-arms it.
      if (waiting) autoStartedRef.current = false;
      waiting = false;
      disarmAutoStartRef.current = null;
      for (const type of events) document.removeEventListener(type, onGesture, true);
      void probe.close();
      setTapToStart(false);
    };
  }, [autoStart, autoStartPicked, config]);

  // The amber CONNECT TO T3 CODE button was tapped: once the pairing links T3, Connected shows for a
  // moment and the settings close onto the normal START CALL. Closing them first drops that intent.
  const closeOnConnectRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the settings sheet closing, outside React
  useEffect(
    () =>
      onVoiceSettingsClosed(() => {
        closeOnConnectRef.current = false;
      }),
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the bridge reaching T3 (after pairing) closes the settings the amber button opened
  useEffect(() => {
    if (down || !closeOnConnectRef.current) return;
    closeOnConnectRef.current = false;
    // Connected shows in the sheet for a moment, so the pairing visibly worked before it closes.
    const timer = window.setTimeout(closeVoiceSettings, CONNECTED_HOLD_MS);
    const stop = onVoiceSettingsClosed(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [down]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- global mic hotkey and teardown
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey && event.altKey && !event.metaKey && event.code === "KeyV") {
        event.preventDefault();
        void toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  // Sending out of a call starts one (the user, 8 Nov), so the reply is spoken and the talk goes on.
  const submitTyped = useEffectEvent(
    async (text: string, images?: ReadonlyArray<File>, files?: ReadonlyArray<VoiceFileRef>) => {
      if (!sessionRef.current?.active) await toggle();
      return send(text, images, files);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands extras/ (cards, which may not import the host) the bar's typed send
  useEffect(() => {
    if (harness) return;
    globalThis.__lalalaSendTyped = (text) => submitTyped(text);
    return () => {
      globalThis.__lalalaSendTyped = undefined;
    };
  }, [harness]);

  const live = phase !== "off" || starting;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors call-live state to callGuard outside React so HMR never reloads mid-call
  useEffect(() => {
    setCallLive(live);
    return () => setCallLive(false);
  }, [live]);

  if (config === null) return null;

  // Offline says why everything else fails; then words that weren't sent (a tap sends them), then the rest.
  const problem = linkDown
    ? OFFLINE_TEXT
    : brainRetrying && phase !== "off"
      ? BRAIN_RETRY_TEXT
      : voiceLoadError !== null && (phase !== "off" || starting)
        ? voiceLoadError
      : notSent && heldCount > 0
      ? NOT_SENT_TEXT
      : error;
  // In a call, a dropped link to T3 shows while it comes back (the harness retries on its own).
  const linkProblem = live ? link : null;
  const paused = micPaused && phase !== "off";
  const message = problem;
  const downloads = live ? loading : null;
  const state: VoiceBarState =
    problem !== null || linkProblem !== null
      ? "error"
      : starting || downloads !== null || paused
        ? "connecting"
        : phase === "transcribing" || (phase === "listening" && !compacting && (thinking || awaitingRun))
          ? quiet
            ? "thinking"
            : "listening"
          : phase;

  return (
    <VoiceBar
      {...bar}
      models={downloads}
      paused={paused}
      tapToStart={tapToStart && phase === "off" && !starting}
      reconnecting={linkProblem !== null}
      disabled={false}
      state={state}
      message={message}
      label={
        phase === "off"
          ? "Start voice (Ctrl+Option+V)"
          : paused
            ? "Resume the mic"
            : phase === "speaking"
            ? "Stop the reply"
            : "Stop voice (Ctrl+Option+V)"
      }
      onPress={() => {
        // The bar says the words weren't sent: a tap sends them again, the call goes on.
        if (message === NOT_SENT_TEXT) {
          setNotSent(false);
          void drain();
          return;
        }
        void toggle();
      }}
      analysis={() => sessionRef.current?.analysis() ?? null}
      stoppedAt={stoppedAt}
      onSubmit={submitTyped}
      upload={
        environmentId === null || harness
          ? undefined
          : (file, onProgress) => uploadVoiceFile(environmentId, file, onProgress)
      }
      live={phase !== "off"}
      offline={
        (down || connectPreview) && !live
          ? () => {
              closeOnConnectRef.current = true;
              openVoiceSettings("Connection");
            }
          : null
      }
      muted={muted}
      compacting={{
        active: compacting,
        startedAt: brainContext?.compactStartedAt ?? compactSentAt,
        estimateMs: compactEstimateMs(brainContext),
      }}
      onMute={() => {
        sessionRef.current?.setMuted(!muted);
        setMuted(!muted);
      }}
    />
  );
}
