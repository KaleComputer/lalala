import { useEffect, useRef, useState } from "react";

import {
  type Session,
  T3Socket,
  launchVoiceThread,
  pairWithLink,
  readBrainThread,
  readSession,
  readWorkspace,
} from "../../../src/voice/adapters/harness/t3";
import { closeVoiceSettings, PickRow, type PickGroup, Row, Section } from "../../../src/voice/VoiceSettings";
import { disconnectBrain, followBrainThread } from "./adapters";

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;
type Connected = { readonly session: Session; readonly socket: T3Socket; readonly workspace: Workspace };

const PAIR_COMMAND =
  "npx t3 pair --scope orchestration:read --scope orchestration:operate --label lalala.talk";
const NEW_THREAD = "";
const SEP = "\u0000";

// Chrome (and Edge) let an https page reach localhost after a prompt; Safari and Firefox do not yet.
const canReachLocal = () =>
  (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.some(
    (brand) => brand.brand === "Chromium",
  ) === true;

const modelValue = (selection: { instanceId: string; model: string } | null | undefined) =>
  selection ? `${selection.instanceId}${SEP}${selection.model}` : "";

/**
 * Pairs lalala.talk with the visitor's own T3 Code, straight from this tab, and picks the thread
 * the call talks to (its brain thread). Starting the call closes the settings onto the bar.
 */
export function ConnectSection() {
  const [connected, setConnected] = useState<Connected | null>(null);
  const [busy, setBusy] = useState(() => readSession() !== null);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState(NEW_THREAD);
  const [model, setModel] = useState("");
  const socketRef = useRef<T3Socket | null>(null);

  async function open(session: Session) {
    const socket = new T3Socket(session);
    await socket.connect();
    socketRef.current = socket;
    const workspace = await readWorkspace(socket);
    const current = readBrainThread(session.origin);
    const thread = workspace.threads.find((candidate) => candidate.id === current);
    const project = workspace.projects.find((p) => p.id === thread?.projectId) ?? workspace.projects[0];
    setProjectId(project?.id ?? "");
    setThreadId(thread?.id ?? NEW_THREAD);
    setModel(modelValue(project?.defaultModelSelection ?? workspace.defaultModel));
    setConnected({ session, socket, workspace });
  }

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    work()
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes this browser's stored pairing (localStorage) and closes the socket with the sheet
  useEffect(() => {
    const stored = readSession();
    if (stored) run(() => open(stored));
    return () => socketRef.current?.close();
  }, []);

  function pair() {
    run(async () => {
      await open(await pairWithLink(link));
      setLink("");
    });
  }

  const title = "Connection";
  const note =
    "lalala.talk talks from this tab straight to T3 Code on your computer. Speech stays in the browser; only your words, as text, reach your T3.";

  if (connected === null) {
    return (
      <Section title={title} note={note}>
        {problem ? <p data-lalala-settings-error="">{problem}</p> : null}
        {canReachLocal() ? null : (
          <p data-lalala-settings-error="">
            This needs Chrome or Edge on the computer running T3 Code: other browsers do not let a
            website reach it yet.
          </p>
        )}
        <Row
          title="1 · Make a pairing link"
          description="Run this on the computer with T3 Code."
          below={<code data-lalala-settings-code="">{PAIR_COMMAND}</code>}
        >
          <button
            type="button"
            data-lalala-settings-button=""
            onClick={() => void navigator.clipboard.writeText(PAIR_COMMAND).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </Row>
        <Row title="2 · Paste the link" description="The link the command printed.">
          <input
            type="url"
            aria-label="Pairing link"
            placeholder="http://127.0.0.1:3773/pair#token=…"
            autoComplete="off"
            spellCheck={false}
            value={link}
            disabled={busy}
            onChange={(event) => setLink(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && link.trim() !== "") pair();
            }}
          />
          <button
            type="button"
            data-lalala-settings-button=""
            disabled={busy || link.trim() === ""}
            onClick={pair}
          >
            {busy ? "Connecting" : "Connect"}
          </button>
        </Row>
        <Row
          title="3 · Allow the local network"
          description="Chrome then asks to let lalala.talk reach your local network. Allow it, or the tab cannot reach your T3 Code."
        >
          {null}
        </Row>
      </Section>
    );
  }

  const { session, socket, workspace } = connected;
  const threads = workspace.threads.filter((thread) => thread.projectId === projectId).slice(0, 30);
  const threadGroups: PickGroup[] = [
    { options: [{ value: NEW_THREAD, label: "New voice thread" }] },
    ...(threads.length > 0
      ? [{ label: "Threads", options: threads.map((thread) => ({ value: thread.id, label: thread.title })) }]
      : []),
  ];
  const modelGroups: PickGroup[] = workspace.providers.map((provider) => ({
    label: provider.name,
    options: provider.models.map((m) => ({ value: `${provider.instanceId}${SEP}${m.slug}`, label: m.name })),
  }));

  const start = () =>
    run(async () => {
      let id = threadId;
      if (id === NEW_THREAD) {
        const [instanceId, slug] = model.split(SEP);
        if (!instanceId || !slug) throw new Error("Pick a model first.");
        id = await launchVoiceThread(socket, projectId, { instanceId, model: slug });
      }
      followBrainThread(session, id);
      closeVoiceSettings();
    });

  return (
    <Section title={title} note={note}>
      {problem ? <p data-lalala-settings-error="">{problem}</p> : null}
      <Row title="T3 Code" description={`${workspace.label} · ${session.origin}`}>
        <span data-lalala-settings-status="" data-ok="">
          Connected
        </span>
      </Row>
      <PickRow
        title="Project"
        label="Project"
        value={projectId}
        disabled={busy}
        groups={[{ options: workspace.projects.map((p) => ({ value: p.id, label: p.title })) }]}
        onChange={(next) => {
          setProjectId(next);
          setThreadId(NEW_THREAD);
        }}
      />
      <PickRow
        title="Thread"
        description="The thread lalala talks to: it answers out loud and hands work to other threads."
        label="Thread"
        value={threadId}
        disabled={busy}
        groups={threadGroups}
        onChange={setThreadId}
      />
      {threadId === NEW_THREAD ? (
        <PickRow
          title="Model"
          label="Model"
          value={model}
          disabled={busy}
          groups={modelGroups}
          onChange={setModel}
        />
      ) : null}
      <Row title="Call" description="Closes the settings and starts talking.">
        <button
          type="button"
          data-lalala-settings-button=""
          disabled={busy || !projectId}
          onClick={start}
        >
          Start call
        </button>
      </Row>
      <Row title="Pairing" description="Forget this pairing; the call stops until you pair again.">
        <button
          type="button"
          data-lalala-settings-button=""
          data-danger=""
          disabled={busy}
          onClick={() => {
            socket.close();
            socketRef.current = null;
            disconnectBrain();
            setConnected(null);
          }}
        >
          Disconnect
        </button>
      </Row>
    </Section>
  );
}
