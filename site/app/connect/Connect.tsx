"use client";

import { useEffect, useRef, useState } from "react";

import { Speaker, canListen, listenOnce, takeSentences } from "./speech";
import {
  type ModelSelection,
  type Session,
  T3Socket,
  followThread,
  forgetSession,
  launchVoiceThread,
  pairWithLink,
  readSession,
  readWorkspace,
  sendMessage,
} from "./t3";

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;
type Line = { id: string; who: "you" | "agent"; text: string };
type Phase = "pair" | "connecting" | "pick" | "talk";

const PAIR_COMMAND =
  "npx t3 pair --scope orchestration:read --scope orchestration:operate --label lalala.talk";

export function Connect() {
  const [phase, setPhase] = useState<Phase>("pair");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [playing, setPlaying] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [typed, setTyped] = useState("");

  const socket = useRef<T3Socket | null>(null);
  const follow = useRef<{ stop(): void } | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const threadId = useRef<string | null>(null);
  const call = useRef({ on: false, busy: false, awaiting: false, listening: null as null | { abort(): void } });
  const spoken = useRef(new Map<string, number>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes a stored pairing on load
  useEffect(() => {
    const session = readSession();
    if (session) void open(session);
    return () => {
      follow.current?.stop();
      socket.current?.close();
      speaker.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(session: Session) {
    setPhase("connecting");
    setError(null);
    try {
      const next = new T3Socket(session);
      await next.connect();
      socket.current = next;
      next.onClose = () => {
        setError("Lost the connection to T3 Code.");
        setPhase("pair");
      };
      const ws = await readWorkspace(next);
      setWorkspace(ws);
      setProjectId(ws.projects[0]?.id ?? "");
      const preferred = ws.projects[0]?.defaultModelSelection ?? ws.defaultModel;
      setModel(preferred ? `${preferred.instanceId}\u0000${preferred.model}` : "");
      setPhase("pick");
    } catch (cause) {
      setError((cause as Error).message);
      setPhase("pair");
    }
  }

  async function pair() {
    setError(null);
    setPhase("connecting");
    try {
      await open(await pairWithLink(link));
      setLink("");
    } catch (cause) {
      setError((cause as Error).message);
      setPhase("pair");
    }
  }

  function disconnect() {
    endCall();
    follow.current?.stop();
    socket.current?.close();
    socket.current = null;
    forgetSession();
    setWorkspace(null);
    setLines([]);
    setPhase("pair");
  }

  function ensureSpeaker() {
    if (!speaker.current) {
      speaker.current = new Speaker();
      speaker.current.onStatus = setVoiceStatus;
      speaker.current.onPlaying = setPlaying;
      speaker.current.onIdle = () => maybeListen();
    }
    speaker.current.unlock();
    return speaker.current;
  }

  async function startThread(existing: string | null) {
    const s = socket.current;
    if (!s) return;
    ensureSpeaker();
    setError(null);
    try {
      let id = existing;
      if (!id) {
        const [instanceId, slug] = model.split("\u0000");
        const selection: ModelSelection = { instanceId, model: slug };
        id = await launchVoiceThread(s, projectId, selection);
      }
      threadId.current = id;
      setLines([]);
      spoken.current.clear();
      follow.current?.stop();
      follow.current = followThread(s, id, {
        onTitle: setTitle,
        onProblem: (text) => {
          setError(text);
          speaker.current?.speak("Something went wrong. It's on the screen.");
        },
        onBusy: (busy) => {
          call.current.busy = busy;
          if (busy) setStatus("Thinking…");
          else {
            call.current.awaiting = false;
            setStatus("");
            maybeListen();
          }
        },
        onReply: (item) => {
          setLines((all) => {
            const rest = all.filter((line) => line.id !== item.id);
            return [...rest, { id: item.id, who: "agent", text: item.text }];
          });
          const from = spoken.current.get(item.id) ?? 0;
          const { ready } = takeSentences(item.text.slice(from), !item.streaming);
          if (ready) {
            spoken.current.set(item.id, from + ready.length);
            speaker.current?.speak(ready);
          }
        },
      });
      setPhase("talk");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function send(text: string) {
    const s = socket.current;
    if (!s || !threadId.current || !text.trim()) return;
    setLines((all) => [...all, { id: crypto.randomUUID(), who: "you", text }]);
    call.current.awaiting = true;
    setError(null);
    setStatus("Sending…");
    try {
      await sendMessage(s, threadId.current, text);
    } catch (cause) {
      call.current.awaiting = false;
      setError((cause as Error).message);
    }
  }

  // Hands-free: listen whenever the call is on and the agent is neither working nor talking.
  function maybeListen() {
    const c = call.current;
    if (!c.on || c.busy || c.awaiting || c.listening || speaker.current?.speaking) return;
    setStatus("Listening…");
    c.listening = listenOnce({
      onInterim: setInterim,
      onError: (e) => {
        setError(e === "not-allowed" ? "The microphone is blocked for this page." : `Speech: ${e}`);
        endCall();
      },
      onDone: (text) => {
        c.listening = null;
        setInterim("");
        if (!c.on) return;
        if (text) void send(text);
        else maybeListen();
      },
    });
  }

  function startCall() {
    ensureSpeaker();
    call.current.on = true;
    setInCall(true);
    maybeListen();
  }

  function endCall() {
    call.current.on = false;
    call.current.listening?.abort();
    call.current.listening = null;
    speaker.current?.stop();
    setInCall(false);
    setInterim("");
    setStatus("");
  }

  const models = workspace?.providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.instanceId}\u0000${m.slug}`, label: `${p.name} · ${m.name}` })),
  );

  return (
    <section className="connect">
      <h2>Talk to your own agent</h2>
      {error && <p className="connect-error">{error}</p>}

      {(phase === "pair" || phase === "connecting") && (
        <div className="connect-step">
          <p>
            lalala.talk connects straight from this tab to T3 Code on your computer. Your words
            and the agent&apos;s replies never pass through our servers. Make a pairing link:
          </p>
          <code className="connect-command">{PAIR_COMMAND}</code>
          <p className="connect-hint">
            Or in T3 Code: Settings → Connections → pair a device, then copy its link.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
          >
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="http://127.0.0.1:3773/pair#token=…"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={!link.trim() || phase === "connecting"}>
              {phase === "connecting" ? "Connecting…" : "Connect"}
            </button>
          </form>
          <p className="connect-hint">
            Chrome asks to let this site reach your local network: allow it. Safari does not let
            https pages reach localhost yet.
          </p>
        </div>
      )}

      {phase === "pick" && workspace && (
        <div className="connect-step">
          <p>
            Connected to <strong>{workspace.label}</strong>.
          </p>
          <div className="connect-row">
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {workspace.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models?.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button disabled={!projectId || !model} onClick={() => void startThread(null)}>
              New voice thread
            </button>
          </div>
          <p className="connect-hint">Or continue a thread:</p>
          <ul className="connect-threads">
            {workspace.threads
              .filter((t) => t.projectId === projectId)
              .slice(0, 12)
              .map((t) => (
                <li key={t.id}>
                  <button onClick={() => void startThread(t.id)}>{t.title}</button>
                </li>
              ))}
          </ul>
          <button className="connect-link" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}

      {phase === "talk" && (
        <div className="connect-step">
          <div className="connect-row">
            <strong className="connect-title">{title}</strong>
            <button className="connect-link" onClick={() => (endCall(), setPhase("pick"))}>
              Other thread
            </button>
          </div>
          <ol className="connect-log">
            {lines.map((line) => (
              <li key={line.id} data-who={line.who}>
                {line.text}
              </li>
            ))}
            {interim && <li data-who="you">{interim}…</li>}
          </ol>
          <p className="connect-hint" aria-live="polite" data-playing={playing}>
            {playing ? "Speaking…" : status || voiceStatus}
          </p>
          <div className="connect-row">
            {canListen() ? (
              <button className="connect-call" data-on={inCall} onClick={inCall ? endCall : startCall}>
                {inCall ? "End call" : "Start call"}
              </button>
            ) : (
              <span className="connect-hint">This browser has no speech recognition; type instead.</span>
            )}
            <form
              className="connect-type"
              onSubmit={(event) => {
                event.preventDefault();
                ensureSpeaker();
                void send(typed);
                setTyped("");
              }}
            >
              <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Or type" />
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
