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
  useHarnessLink,
  useProjects,
  useThreadShells,
  useThreadVisibleTurnItems,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerSettingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { markBriefed, needsBrief, withBrief, withCanvas } from "./brief";
import type { ModelProgress } from "./adapters";
import { speechEngine, useSpeechEngine } from "./engine";
import { asksToSee, followCommand, isFollowing, setFollowing, takeFocus } from "./follow";
import { type VoicePhase, VoiceSession } from "./speech";
import { takeSentences } from "./speechText";
import { VoiceBar, type VoiceBarState } from "./VoiceBar";
import { endVoiceLogSession, startVoiceLogSession, voiceLog } from "./voiceLog";
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
/** The brain puts this before outside material, at the start or after its answer to the user (brain.md). */
const NEW_TOPIC_TAG = /\s*\[new topic\]\s*/gi;
// The marker becomes a paragraph break plus this invisible mark, so the material after it is its
// own sentence and the topic sound plays right before it.
const TOPIC_MARK = "\u2063";
const TIDY_TAG = /\[tidy\]\s*/gi;

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
  const showMeRef = useRef(false);
  // The thread this client just created, until its shell arrives.
  const pendingThreadIdRef = useRef<ThreadId | null>(null);

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
  const items = useThreadVisibleTurnItems(phase === "off" ? null : voiceThreadRef);
  const thinking = threadRuntimeIsActive(voiceThread?.runtime);

  // lalala.talk: the harness and speech adapters stand in for the dev server and the speech service.
  const harness = globalThis.__lalalaAdapters?.harness;
  const speech = globalThis.__lalalaAdapters?.speech;
  // The in-browser models' download and warm-up (the bar's readout); null once ready.
  const [loading, setLoading] = useState<ReadonlyArray<ModelProgress> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the dev server's voice config once
  useEffect(() => {
    let cancelled = false;
    (harness
      ? harness.config()
      : fetch("/__lalala/config").then((response) =>
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
      fetch("/__lalala/local/health")
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (!cancelled)
            setLocalProblem(response.ok ? null : (body.error ?? "Local speech is down"));
        })
        .catch(() => {
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs the brain-edited theme file as T3's "Voice" theme
  useEffect(() => syncVoiceTheme(), []);

  /** The user's words (spoken, or typed in the bar's input with its pictures) as a turn on the voice thread, made on first use. */
  const send = useEffectEvent(async (text: string, images: ReadonlyArray<File> = []) => {
    if (environmentId === null || project === undefined) {
      setError("No brain thread yet: pair with T3 Code in the settings.");
      return false;
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
    const message = { messageId: newMessageId(), role: "user" as const, attachments };
    const existingThreadId = voiceThread?.id ?? pendingThreadIdRef.current;
    if (existingThreadId === null && modelSelection === null) {
      setError("Pick a default model in Settings first.");
      return false;
    }
    const threadId = existingThreadId ?? newThreadId();
    if (existingThreadId === null) pendingThreadIdRef.current = threadId;
    const follow = followCommand(text);
    if (follow !== undefined) setFollowing(follow);
    showMeRef.current = asksToSee(text);
    const briefed = existingThreadId === null || needsBrief(threadId, items);
    const turnText = briefed ? withBrief(withCanvas(text)) : withCanvas(text);
    const result =
      existingThreadId !== null || modelSelection === null
        ? await startTurn({
            environmentId,
            input: {
              threadId,
              message: { ...message, text: turnText },
              runtimeMode: voiceThread?.runtimeMode ?? "full-access",
              interactionMode: voiceThread?.interactionMode ?? "default",
              createdAt,
            },
          })
        : await startTurn({
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
    if (result._tag === "Failure") {
      if (existingThreadId === null) pendingThreadIdRef.current = null;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
    if (briefed) markBriefed(threadId);
    voiceLog("user", "send", { text, briefed, threadId, images: images.length });
    sentAtRef.current = performance.now();
    sentEpochRef.current = Date.now();
    workStartedRef.current = false;
    firstTextLoggedRef.current = false;
    return true;
  });

  const toggle = useEffectEvent(async () => {
    const current = sessionRef.current;
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
    });
    startVoiceLogSession({ engine: speechEngine(), thread: voiceThread?.id ?? null });
    sessionRef.current = session;
    sessionStartedAtRef.current = Date.now();
    setStarting(true);
    try {
      await session.start();
    } catch (cause) {
      sessionRef.current = null;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the session while the brain works, so the user needs a little more to cut in (Presence's think bar)
  useEffect(() => {
    sessionRef.current?.setThinking(thinking);
  }, [thinking]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- speaks the voice thread's replies sentence by sentence as they stream while the mic is on
  useEffect(() => {
    const session = sessionRef.current;
    if (session === null) return;
    for (const { item, visibility } of items) {
      const startedAt = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
      const thisTurn = sentEpochRef.current > 0 && startedAt >= sentEpochRef.current - 500;
      if (thisTurn && !TALK_ITEMS.has(item.type)) workStartedRef.current = true;
      if (item.type !== "assistant_message" || visibility !== "local") continue;
      if (item.parentItemId !== null) continue;
      if (startedAt < sessionStartedAtRef.current - 1_000) continue;
      // Focus tags move the canvas and are never spoken, nor is the brain's `[new topic]` marker.
      const tidy = item.text.match(TIDY_TAG) !== null;
      const { text, cards } = takeFocus(
        item.text.replace(NEW_TOPIC_TAG, `\n\n${TOPIC_MARK}`).replace(TIDY_TAG, ""),
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
      if (!item.streaming) finishedRef.current.add(item.id);
      for (const [index, sentence] of sentences.entries()) {
        voiceLog("brain", "sentence", {
          text: sentence,
          streaming: item.streaming,
          msSinceSend:
            sentAtRef.current > 0 ? Math.round(performance.now() - sentAtRef.current) : null,
        });
        const switching = sentence.trimStart().startsWith(TOPIC_MARK);
        const opensReply = (queued === 0 && index === 0) || switching;
        session.speak(sentence.replaceAll(TOPIC_MARK, ""), opensReply, switching);
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
  const problem = error ?? unavailable;
  const live = phase !== "off" || starting;
  // In a call, a dropped link to T3 shows while it comes back (the harness retries on its own).
  const linkProblem = live ? link : null;
  const message = problem ?? linkProblem;
  const downloads = live ? loading : null;
  const state: VoiceBarState =
    problem !== null
      ? "error"
      : starting || downloads !== null || linkProblem !== null
        ? "connecting"
        : phase === "transcribing" || (phase === "listening" && (thinking || awaitingRun))
          ? quiet
            ? "thinking"
            : "listening"
          : phase;

  return (
    <VoiceBar
      {...bar}
      downloads={downloads}
      disabled={false}
      state={state}
      message={message}
      label={
        phase === "off"
          ? "Start voice (Ctrl+Option+V)"
          : phase === "speaking"
            ? "Stop the reply"
            : "Stop voice (Ctrl+Option+V)"
      }
      onPress={() => void toggle()}
      analysis={() => sessionRef.current?.analysis() ?? null}
      stoppedAt={stoppedAt}
      onSubmit={(text, images) => send(text, images)}
      live={phase !== "off"}
      muted={muted}
      onMute={() => {
        const session = sessionRef.current;
        if (!session?.active) return;
        session.setMuted(!muted);
        setMuted(!muted);
      }}
    />
  );
}
