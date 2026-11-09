import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ComponentProps, useEffect, useEffectEvent, useRef, useState } from "react";

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
import { applyCardTags, takeCards } from "./brainCards";
import { compactEstimateMs, compactionDue, shareBrainThread } from "./brainCompaction";
import { useCompactSim } from "./compactSim";
import { markBriefed, needsBrief, withBrief, withCanvas } from "./brief";
import type { ModelProgress } from "./adapters";
import { speechEngine, useSpeechEngine } from "./engine";
import { asksToSee, followCommand, isFollowing, setFollowing, takeFocus } from "./follow";
import { type VoicePhase, VoiceSession } from "./speech";
import { takeSentences } from "./speechText";
import { VoiceBar, type VoiceBarState } from "./VoiceBar";
import { closeVoiceSettings, CONNECTED_HOLD_MS, onVoiceSettingsClosed, openVoiceSettings } from "./VoiceSettings";
import { endVoiceLogSession, startVoiceLogSession, voiceLog } from "./voiceLog";
import {
  isGatewayStatus,
  NOT_SENT_TEXT,
  OFFLINE_TEXT,
  REQUEST_TIMEOUT_MS,
  UNREACHABLE_TEXT,
  voiceErrorText,
} from "./voiceErrors";
import { checkLink, linkIsDown, markLinkDown, markLinkUp, onLinkUp, useLinkDown } from "./voiceLink";
import { type HeldWords, heldWords, holdWords, releaseWords, useHeldCount } from "./voiceOutbox";
import { syncVoiceTheme } from "./voiceThemeSync";

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
const LOCAL_HEALTH_EVERY_MS = 10_000;
const RECONNECT_EVERY_MS = 2_000;
/** The brain puts this before outside material, at the start or after its answer to the user (brain.md). */
const NEW_TOPIC_TAG = /\s*\[new topic\]\s*/gi;
// The marker becomes a paragraph break plus this invisible mark, so the material after it is its
// own sentence and the topic sound plays right before it.
const TOPIC_MARK = "\u2063";
const TIDY_TAG = /\[tidy\]\s*/gi;
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
  const engine = useSpeechEngine();
  // Why local speech cannot be used right now (service down or loading); null when it is ready.
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
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
  const tidiedRef = useRef(new Set<string>());
  // How many `[new topic]` parts of each reply have started, by turn item id.
  const topicPartsRef = useRef(new Map<string, number>());
  // The user's latest words: a reply after them on the thread is their answer.
  const awaitedMessageRef = useRef<string | null>(null);
  const showMeRef = useRef(false);
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
  const speech = globalThis.__lalalaAdapters?.speech;
  // Out of a call too where the brain's replies carry cards (brainCards.ts).
  const items = useThreadVisibleTurnItems(
    phase === "off" && !harness?.readFile ? null : voiceThreadRef,
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
  // Dev's pretend compaction (settings) shows in the bar unless a real one runs.
  const compactSim = useCompactSim();
  const compacting =
    brainContext?.compacting === true ||
    (compactSentAt !== null && (brainContext?.compactedAt ?? 0) < compactSentAt);

  // The in-browser models' download and warm-up (the bar's readout); null once ready.
  const [loading, setLoading] = useState<ReadonlyArray<ModelProgress> | null>(null);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the local speech service while it is the chosen engine, so the bar says when it is down instead of falling back
  useEffect(() => {
    if (engine !== "local" || speech) return;
    let cancelled = false;
    const check = () =>
      fetch("/__lalala/local/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          // lalala answers 503 with its reason while models load; a front door answers 502-504
          // with no reason when lalala isn't behind it.
          if (isGatewayStatus(response.status) && body.error === undefined) {
            markLinkDown("health gateway");
          } else markLinkUp();
          if (!cancelled)
            setLocalProblem(response.ok ? null : (body.error ?? "Local speech is down"));
        })
        .catch(() => {
          // No answer at all: the page can't reach lalala, so its words wait (voiceOutbox).
          markLinkDown("health");
          if (!cancelled) setLocalProblem("Local speech is down");
        });
    void check();
    const timer = window.setInterval(check, LOCAL_HEALTH_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [engine]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the in-browser models' load state (workers outside React) while a call is on
  useEffect(() => {
    if (!speech?.progress || (phase === "off" && !starting)) return;
    const read = () => setLoading(speech.progress?.() ?? null);
    read();
    const timer = window.setInterval(read, 250);
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
  const send = (text: string, images: ReadonlyArray<File> = []) => {
    sessionRef.current?.awaitAnswer();
    awaitedMessageRef.current = holdWords(text, images).messageId;
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

  /** The user's words (spoken, or typed in the bar's input with its pictures) as a turn on the voice thread, made on first use. */
  const sendNow = useEffectEvent(async ({ text, images, messageId }: HeldWords): Promise<SendOutcome> => {
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
    const message = { messageId, role: "user" as const, attachments };
    const existingThreadId = voiceThread?.id ?? pendingThreadIdRef.current;
    if (existingThreadId === null && modelSelection === null) {
      setError("Pick a default model in Settings first.");
      return { sent: false, retry: false, message: "no default model" };
    }
    const threadId = existingThreadId ?? newThreadId();
    if (existingThreadId === null) pendingThreadIdRef.current = threadId;
    const follow = followCommand(text);
    if (follow !== undefined) setFollowing(follow);
    showMeRef.current = asksToSee(text);
    const briefed =
      existingThreadId === null || needsBrief(threadId, items, brainContext?.compactedAt ?? null);
    const turnText = briefed ? withBrief(withCanvas(text)) : withCanvas(text);
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
              threadId,
              message: { ...message, text: turnText },
              runtimeMode: voiceThread?.runtimeMode ?? "full-access",
              interactionMode: voiceThread?.interactionMode ?? "default",
              createdAt,
            },
          })
        : startTurn({
            environmentId,
            input: {
              threadId,
              message: { ...message, text: turnText },
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
      // The server path's send aborts itself after the same time (a TimeoutError).
      if (result === "timeout" || (failure instanceof DOMException && failure.name === "TimeoutError")) {
        return { sent: false, retry: true, message: "send timed out", timedOut: true };
      }
      return { sent: false, retry: true, message: voiceErrorText(failure) };
    }
    if (briefed) markBriefed(threadId);
    voiceLog("user", "send", { text, briefed, threadId, images: images.length });
    sentAtRef.current = performance.now();
    sentEpochRef.current = Date.now();
    workStartedRef.current = false;
    firstTextLoggedRef.current = false;
    return { sent: true };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the held words when the link (voiceLink, outside React) comes back
  useEffect(() => onLinkUp(() => void drain()), []);

  // Words held before a reload go once the voice thread is known (sooner, a new thread would start).
  const voiceThreadKnown = voiceThread !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends words a reload left in the outbox (sessionStorage) once the thread is there
  useEffect(() => {
    if (voiceThreadKnown && heldWords().length > 0) void drain();
  }, [voiceThreadKnown]);

  const toggle = useEffectEvent(async () => {
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
      endVoiceLogSession("mic off (tap)");
      return;
    }
    setError(null);
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
    startVoiceLogSession({ engine: speechEngine(), thread: voiceThread?.id ?? null });
    sessionRef.current = session;
    sessionStartedAtRef.current = Date.now();
    setStarting(true);
    void compactIfDue("call start");
    try {
      await session.start();
      // Muted before the call: it starts muted.
      if (muted) session.setMuted(true);
    } catch (cause) {
      sessionRef.current = null;
      setError(voiceErrorText(cause));
    } finally {
      setStarting(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the session while the brain works, so the user needs a little more to cut in (Presence's think bar)
  useEffect(() => {
    sessionRef.current?.setThinking(thinking);
  }, [thinking]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the cards named in the brain's finished replies on the canvas, reading their files from T3
  useEffect(() => {
    const readFile = harness?.readFile;
    if (readFile && voiceThread) applyCardTags(voiceThread.id, items, readFile);
  }, [items, voiceThread?.id]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- speaks the voice thread's replies sentence by sentence as they stream while the mic is on
  useEffect(() => {
    const session = sessionRef.current;
    if (session === null) return;
    const awaited = awaitedMessageRef.current;
    const asked = items.find(
      ({ item }) => item.type === "user_message" && item.messageId === awaited,
    )?.item;
    // The bridge's rows are in update order, so "after their words" is by the server's start times.
    const askedAt = asked ? DateTime.toEpochMillis(asked.startedAt ?? asked.updatedAt) : undefined;
    for (const { item, visibility } of items) {
      const startedAt = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
      const thisTurn = sentEpochRef.current > 0 && startedAt >= sentEpochRef.current - 500;
      if (thisTurn && !TALK_ITEMS.has(item.type)) workStartedRef.current = true;
      if (item.type !== "assistant_message" || visibility !== "local") continue;
      if (item.parentItemId !== null) continue;
      if (startedAt < sessionStartedAtRef.current - 1_000) continue;
      // Focus and card tags are never spoken, nor is the brain's `[new topic]` marker.
      const tidy = item.text.match(TIDY_TAG) !== null;
      const { text, cards } = takeFocus(
        takeCards(item.text)
          .text.replace(NEW_TOPIC_TAG, `\n\n${TOPIC_MARK}`)
          .replace(TIDY_TAG, ""),
      );
      if (thisTurn && tidy && !tidiedRef.current.has(item.id)) {
        tidiedRef.current.add(item.id);
        voiceLog("brain", "tidy", {});
        globalThis.__lalalaCanvases?.tidy?.();
      }
      const focused = focusedRef.current.get(item.id) ?? 0;
      if (thisTurn && cards.length > focused) {
        focusedRef.current.set(item.id, cards.length);
        const card = cards.at(-1);
        if (card && (isFollowing() || showMeRef.current)) {
          voiceLog("brain", "focus", { card });
          globalThis.__lalalaCanvases?.focus?.(card);
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
        const switching = sentence.trimStart().startsWith(TOPIC_MARK);
        const opensReply = (queued === 0 && index === 0) || switching;
        // What follows a `[new topic]` waits while the user's turn is open (topicHold); the rest answers them.
        const parts = (topicPartsRef.current.get(item.id) ?? 0) + (switching ? 1 : 0);
        topicPartsRef.current.set(item.id, parts);
        const part = parts > 0 ? `${item.id}#${parts}` : undefined;
        session.speak(sentence.replaceAll(TOPIC_MARK, ""), opensReply, switching, part);
      }
      if (item.streaming) continue;
      finishedRef.current.add(item.id);
      // A finished reply after their words that doesn't open on `[new topic]` is their answer ("..." too).
      if (askedAt !== undefined && startedAt >= askedAt && !text.trimStart().startsWith(TOPIC_MARK)) {
        session.answered();
      }
    }
  }, [items]);

  const autoStartedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the call once its config (read from the harness) is in
  useEffect(() => {
    if (!autoStart || config === null || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void toggle();
  }, [autoStart, config]);

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

  if (config === null) return null;

  // Local speech needs its service up.
  const unavailable = localProblem;
  // Offline says why everything else fails; then words that weren't sent (a tap sends them), then the rest.
  const problem = linkDown
    ? OFFLINE_TEXT
    : notSent && heldCount > 0
      ? NOT_SENT_TEXT
      : (error ?? unavailable);
  const live = phase !== "off" || starting;
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
        : phase === "transcribing" || (phase === "listening" && (thinking || awaitingRun))
          ? quiet
            ? "thinking"
            : "listening"
          : phase;

  return (
    <VoiceBar
      {...bar}
      models={downloads}
      paused={paused}
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
      // Sending out of a call starts one (the user, 8 Nov), so the reply is spoken and the talk goes on.
      onSubmit={async (text, images) => {
        if (!sessionRef.current?.active) await toggle();
        return send(text, images);
      }}
      live={phase !== "off"}
      offline={
        down && !live
          ? () => {
              closeOnConnectRef.current = true;
              openVoiceSettings("Connection");
            }
          : null
      }
      muted={muted}
      compacting={
        compactSim !== null && !compacting
          ? compactSim
          : {
              active: compacting,
              startedAt: brainContext?.compactStartedAt ?? compactSentAt,
              estimateMs: compactEstimateMs(brainContext),
            }
      }
      onMute={() => {
        sessionRef.current?.setMuted(!muted);
        setMuted(!muted);
      }}
    />
  );
}
