"use client";

import { useEffect, useState } from "react";

import {
  type Session,
  T3Socket,
  forgetSession,
  launchVoiceThread,
  pairWithLink,
  readBrainThread,
  readSession,
  readWorkspace,
  saveBrainThread,
} from "../../../src/voice/adapters/harness/t3";

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;
type Phase = "pair" | "connecting" | "pick";

const PAIR_COMMAND =
  "npx t3 pair --scope orchestration:read --scope orchestration:operate --label lalala.talk";

// Chrome (and Edge) let an https page reach localhost after a prompt; Safari and Firefox do not yet.
const canReachLocal = () =>
  (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.some(
    (brand) => brand.brand === "Chromium",
  ) === true;

/**
 * Pairs lalala.talk with the visitor's own T3 Code and picks the thread the canvas's call talks to
 * (its brain thread). The call itself runs on the canvas, like in the app.
 */
export function Connect() {
  const [phase, setPhase] = useState<Phase>("pair");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [socket, setSocket] = useState<T3Socket | null>(null);
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [supported, setSupported] = useState(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes a stored pairing on load (localStorage, outside React)
  useEffect(() => {
    setSupported(canReachLocal());
    const stored = readSession();
    if (stored) void open(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(next: Session) {
    setPhase("connecting");
    setError(null);
    try {
      const connected = new T3Socket(next);
      await connected.connect();
      const ws = await readWorkspace(connected);
      setSocket(connected);
      setSession(next);
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

  function use(threadId: string) {
    if (!session) return;
    saveBrainThread(session.origin, threadId);
    socket?.close();
    location.href = "/";
  }

  async function startThread() {
    if (!socket || !workspace) return;
    const [instanceId, slug] = model.split("\u0000");
    if (!instanceId || !slug) return setError("Pick a model first.");
    try {
      use(await launchVoiceThread(socket, projectId, { instanceId, model: slug }));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  function disconnect() {
    socket?.close();
    forgetSession();
    setSocket(null);
    setSession(null);
    setWorkspace(null);
    setPhase("pair");
  }

  const current = session ? readBrainThread(session.origin) : null;

  return (
    <section className="connect">
      <h2>Talk to your own agents</h2>
      {error && <p className="connect-error">{error}</p>}

      {!supported && (
        <p className="connect-hint">
          This needs Chrome or Edge on the computer running T3 Code: other browsers do not let a
          website reach your computer&apos;s T3 Code yet.
        </p>
      )}

      {(phase === "pair" || phase === "connecting") && (
        <div className="connect-step">
          <p>
            lalala.talk talks straight from this tab to T3 Code on your computer. Speech runs on
            your device; only your words, as text, go to your own T3. Make a pairing link:
          </p>
          <div className="connect-row">
            <code className="connect-command">{PAIR_COMMAND}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(PAIR_COMMAND).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
          >
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="paste the pairing link (http://127.0.0.1:3773/pair#token=…)"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={!link.trim() || phase === "connecting"}>
              {phase === "connecting" ? "Connecting…" : "Connect"}
            </button>
          </form>
          <p className="connect-hint">Chrome then asks to let this site reach your local network: allow it.</p>
        </div>
      )}

      {phase === "pick" && workspace && (
        <div className="connect-step">
          <p>
            Connected to <strong>{workspace.label}</strong>. Pick the thread lalala talks to, or
            start a new one:
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
              {workspace.providers.flatMap((p) =>
                p.models.map((m) => (
                  <option key={`${p.instanceId}/${m.slug}`} value={`${p.instanceId}\u0000${m.slug}`}>
                    {p.name} · {m.name}
                  </option>
                )),
              )}
            </select>
            <button disabled={!projectId || !model} onClick={() => void startThread()}>
              New voice thread
            </button>
          </div>
          <ul className="connect-threads">
            {workspace.threads
              .filter((t) => t.projectId === projectId)
              .slice(0, 12)
              .map((t) => (
                <li key={t.id}>
                  <button data-current={t.id === current} onClick={() => use(t.id)}>
                    {t.title}
                  </button>
                </li>
              ))}
          </ul>
          <div className="connect-row">
            {current ? (
              <a className="connect-link" href="/">
                Back to the canvas
              </a>
            ) : null}
            <button className="connect-link" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
