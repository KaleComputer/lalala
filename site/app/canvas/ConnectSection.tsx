import { useEffect, useRef, useState } from "react";

import {
  LALALA_PROJECT,
  type Session,
  T3Socket,
  VOICE_THREAD_TITLE,
  ensureLalalaProject,
  launchVoiceThread,
  localNetworkPermission,
  localNetworkProblem,
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
const CREATING = `Creating a "${LALALA_PROJECT}" project in your home folder for your voice thread.`;
const CREATED = `Created a "${LALALA_PROJECT}" project in your home folder for your voice thread.`;
const SEP = "\u0000";

// Chrome (and Edge) let an https page reach localhost after a prompt; Safari and Firefox do not yet.
const canReachLocal = () =>
  (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.some(
    (brand) => brand.brand === "Chromium",
  ) === true;

const modelValue = (selection: { instanceId: string; model: string } | null | undefined) =>
  selection ? `${selection.instanceId}${SEP}${selection.model}` : "";

const firstModel = (workspace: Workspace) => {
  const provider = workspace.providers[0];
  const slug = provider?.models[0]?.slug;
  return provider && slug ? { instanceId: provider.instanceId, model: slug } : null;
};

/** A cropped screenshot of T3 Code's own UI, showing where to click. */
const Shot = (props: { src: string; width: number; height: number; alt: string }) => (
  <img data-lalala-settings-shot="" {...props} loading="lazy" decoding="async" />
);

type Pick = { readonly projectId: string; readonly threadId: string; readonly model: string };

/**
 * Pairs lalala.talk with the visitor's own T3 Code, straight from this tab, and sets up the thread
 * the call talks to (its brain thread), then closes onto the bar. Picks made later apply at once.
 */
export function ConnectSection() {
  const [connected, setConnected] = useState<Connected | null>(null);
  const [busy, setBusy] = useState(() => readSession() !== null);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [way, setWay] = useState<"app" | "terminal">("app");
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState(NEW_THREAD);
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const socketRef = useRef<T3Socket | null>(null);

  async function open(session: Session): Promise<Connected & Pick> {
    const socket = new T3Socket(session);
    await socket.connect();
    socketRef.current = socket;
    const read = await readWorkspace(socket);
    // No project picking by default: the voice thread lives in lalala's own project.
    if (!read.projects.some((p) => p.title === LALALA_PROJECT && !p.archivedAt)) setNotice(CREATING);
    const { project: own, created } = await ensureLalalaProject(socket, read.projects);
    setNotice(created ? CREATED : null);
    const workspace = {
      ...read,
      projects: [own, ...read.projects.filter((p) => p.id !== own.id && !p.archivedAt)],
    };
    const current = readBrainThread(session.origin);
    const thread =
      workspace.threads.find((candidate) => candidate.id === current) ??
      workspace.threads.find((t) => t.projectId === own.id && t.title === VOICE_THREAD_TITLE);
    const project = workspace.projects.find((p) => p.id === thread?.projectId) ?? own;
    const pick = {
      projectId: project.id,
      threadId: thread?.id ?? NEW_THREAD,
      model: modelValue(project.defaultModelSelection ?? workspace.defaultModel ?? firstModel(workspace)),
    };
    setProjectId(pick.projectId);
    setChoosing(project.id !== own.id);
    setThreadId(pick.threadId);
    setModel(pick.model);
    setConnected({ session, socket, workspace });
    return { session, socket, workspace, ...pick };
  }

  /** Points the call at the picked thread, launching a new voice thread first when asked. */
  async function follow(to: Connected & Pick) {
    let id = to.threadId;
    if (id === NEW_THREAD) {
      const [instanceId, slug] = to.model.split(SEP);
      if (!instanceId || !slug) throw new Error("Pick a model for the voice thread.");
      id = await launchVoiceThread(to.socket, to.projectId, { instanceId, model: slug });
      const thread = { id, projectId: to.projectId, title: VOICE_THREAD_TITLE };
      setConnected({ ...to, workspace: { ...to.workspace, threads: [thread, ...to.workspace.threads] } });
    }
    setThreadId(id);
    followBrainThread(to.session, id);
  }

  /** Connected and set up: the settings close onto the bar (whose call starts if a tap led here). */
  async function finish(to: Connected & Pick) {
    await follow(to);
    closeVoiceSettings();
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
    // A pairing whose thread was never set up (or failed) finishes now, as a fresh one does.
    if (stored)
      run(async () => {
        const to = await open(stored);
        if (readBrainThread(stored.origin) === null) await finish(to);
      });
    return () => socketRef.current?.close();
  }, []);

  function pair(input = link) {
    run(async () => {
      let session: Session;
      try {
        session = await pairWithLink(input);
      } catch (cause) {
        // Waiting on Chrome's local network permission: pair as soon as the user allows it.
        const permission = await localNetworkPermission();
        if (permission && localNetworkProblem(permission))
          permission.onchange = () => {
            if (permission.state !== "granted") return;
            permission.onchange = null;
            pair(input);
          };
        throw cause;
      }
      const to = await open(session);
      setLink("");
      await finish(to);
    });
  }

  const pasteRow = (title: string, description: string, placeholder: string, label: string) => (
    <Row title={title} description={description}>
      <input
        type="text"
        aria-label={label}
        placeholder={placeholder}
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
        onClick={() => pair()}
      >
        {busy ? "Connecting" : "Connect"}
      </button>
    </Row>
  );

  const title = "Connection";
  const note =
    "lalala.talk talks from this tab straight to T3 Code on your computer. Speech stays in the browser; only your words, as text, reach your T3.";

  if (connected === null) {
    return (
      <Section title={title} note={note}>
        {problem ? <p data-lalala-settings-error="">{problem}</p> : null}
        {busy && notice ? <p data-lalala-settings-info="">{notice}</p> : null}
        {canReachLocal() ? null : (
          <p data-lalala-settings-error="">
            This needs Chrome or Edge on the computer running T3 Code: other browsers do not let a
            website reach it yet.
          </p>
        )}
        <Row title="Pair" description="Make the pairing in T3 Code's settings, or with one terminal command.">
          <div role="radiogroup" aria-label="How to pair" data-lalala-settings-segments="">
            {(["app", "terminal"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={way === option}
                onClick={() => setWay(option)}
              >
                {option === "app" ? "From T3 Code" : "With the terminal"}
              </button>
            ))}
          </div>
        </Row>
        {way === "app" ? (
          <>
            <Row
              title="1 · Create a link"
              description="In T3 Code, open Settings → Sharing & access and click Create link."
              below={<Shot src="/connect/step1.png" width={500} height={26} alt="T3 Code's Authorized clients row with its Create link button" />}
            >
              {null}
            </Row>
            <Row
              title="2 · Set it up"
              description="Name it lalala.talk, keep only View environment and Operate tasks ticked, then click Create link."
              below={<Shot src="/connect/step2.png" width={360} height={178} alt="T3 Code's Create pairing link dialog: label lalala.talk, View environment and Operate tasks ticked" />}
            >
              {null}
            </Row>
            <Row
              title="3 · Copy the link"
              description="The new lalala.talk row shows the link and a QR code: click Copy link. Where T3 shows only Copy code, copy that."
              below={<Shot src="/connect/step3.png" width={460} height={146} alt="The new pairing in T3 Code: its link with Copy link, Copy code only, and a QR code" />}
            >
              {null}
            </Row>
            {pasteRow("4 · Paste it", "The link or code T3 Code copied.", "Pairing link or code", "Pairing link or code")}
          </>
        ) : (
          <>
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
            {pasteRow("2 · Paste the link", "The link the command printed.", "http://127.0.0.1:3773/pair#token=…", "Pairing link")}
          </>
        )}
        <Row
          title={`${way === "app" ? 5 : 3} · Allow the local network`}
          description="Chrome then asks to let lalala.talk reach your local network: allow it. Blocked it before? Click the icon left of the address bar, open Site settings and set Local network access to Allow."
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

  const repick = (next: Partial<Pick>) => {
    const to = { session, socket, workspace, projectId, threadId, model, ...next };
    setProjectId(to.projectId);
    setModel(to.model);
    run(() => follow(to));
  };

  return (
    <Section title={title} note={note}>
      {problem ? <p data-lalala-settings-error="">{problem}</p> : null}
      <Row
        title="T3 Code"
        description={`${workspace.label} · ${session.origin} · pairing valid until ${new Date(session.expiresAt).toLocaleDateString()}`}
      >
        <span data-lalala-settings-status="" data-ok="">
          Connected
        </span>
      </Row>
      {notice ? <p data-lalala-settings-info="">{notice}</p> : null}
      {choosing ? (
        <PickRow
          title="Project"
          description={`The T3 project the thread lives in; "${LALALA_PROJECT}" is lalala's own.`}
          label="Project"
          value={projectId}
          disabled={busy}
          groups={[{ options: workspace.projects.map((p) => ({ value: p.id, label: p.title })) }]}
          onChange={(next) =>
            repick({
              projectId: next,
              threadId:
                workspace.threads.find((t) => t.projectId === next && t.title === VOICE_THREAD_TITLE)?.id ??
                NEW_THREAD,
            })
          }
        />
      ) : null}
      <PickRow
        title="Thread"
        description="The thread lalala talks to: it answers out loud and hands work to other threads."
        label="Thread"
        value={threadId}
        disabled={busy}
        groups={threadGroups}
        onChange={(next) => repick({ threadId: next })}
      />
      <PickRow
        title="Model"
        description="For new voice threads."
        label="Model"
        value={model}
        disabled={busy}
        groups={modelGroups}
        onChange={(next) => (threadId === NEW_THREAD ? repick({ model: next }) : setModel(next))}
      />
      {choosing ? null : (
        <Row title="Advanced" description={`The thread lives in lalala's own "${LALALA_PROJECT}" project.`}>
          <button type="button" data-lalala-settings-button="" disabled={busy} onClick={() => setChoosing(true)}>
            Choose another project
          </button>
        </Row>
      )}
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
