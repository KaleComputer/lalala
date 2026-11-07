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
  pingServer,
  readBrainThread,
  readSession,
  readWorkspace,
} from "../../../src/voice/adapters/harness/t3";
import { browserSupport, ConnectedRows, PairSteps } from "../../../src/voice/ConnectFlow";
import { readPairing } from "../../../src/voice/pairing";
import { closeVoiceSettings, PickRow, type PickGroup, Row, Section } from "../../../src/voice/VoiceSettings";
import { disconnectBrain, followBrainThread } from "./adapters";

type Workspace = Awaited<ReturnType<typeof readWorkspace>>;
type Connected = { readonly session: Session; readonly socket: T3Socket; readonly workspace: Workspace };

const PAIR_COMMAND =
  "npx t3 pair --scope orchestration:read --scope orchestration:operate --label lalala.talk";
const NEW_THREAD = "";
const CREATED = `Created a "${LALALA_PROJECT}" project in your home folder for your voice thread.`;
const SEP = "\u0000";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const answered = (ms: number) => `answered in ${ms} ms`;

const modelValue = (selection: { instanceId: string; model: string } | null | undefined) =>
  selection ? `${selection.instanceId}${SEP}${selection.model}` : "";

const firstModel = (workspace: Workspace) => {
  const provider = workspace.providers[0];
  const slug = provider?.models[0]?.slug;
  return provider && slug ? { instanceId: provider.instanceId, model: slug } : null;
};

type Pick = { readonly projectId: string; readonly threadId: string; readonly model: string };

/**
 * Pairs lalala.talk with the visitor's own T3 Code, straight from this tab. A pasted link does the
 * rest on its own: pair, check T3 answers, set up the voice thread, show Connected (and start the
 * call when the call button led here). Picks made later apply at once.
 */
export function ConnectSection() {
  const [connected, setConnected] = useState<Connected | null>(null);
  const [working, setWorking] = useState<string | null>(() =>
    readSession() !== null ? "Connecting to T3 Code…" : null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
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
    setWorking("Checking the connection…");
    const read = await readWorkspace(socket);
    setChecked(answered(await pingServer(socket)));
    // No project picking by default: the voice thread lives in lalala's own project.
    if (!read.projects.some((p) => p.title === LALALA_PROJECT && !p.archivedAt))
      setWorking(`Creating a "${LALALA_PROJECT}" project in your home folder…`);
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
    return { session, socket, workspace, ...pick };
  }

  /** Points the call at the picked thread, launching a new voice thread first when asked. */
  async function follow(to: Connected & Pick) {
    let id = to.threadId;
    if (id === NEW_THREAD) {
      const [instanceId, slug] = to.model.split(SEP);
      if (!instanceId || !slug) throw new Error("Pick a model for the voice thread.");
      setWorking("Setting up your voice thread…");
      id = await launchVoiceThread(to.socket, to.projectId, { instanceId, model: slug });
      const thread = { id, projectId: to.projectId, title: VOICE_THREAD_TITLE };
      to = { ...to, workspace: { ...to.workspace, threads: [thread, ...to.workspace.threads] } };
    }
    setThreadId(id);
    setConnected({ session: to.session, socket: to.socket, workspace: to.workspace });
    return followBrainThread(to.session, id);
  }

  /** Connected and set up: Connected shows, or the settings close onto a call the call button asked for. */
  async function finish(to: Connected & Pick) {
    if (await follow(to)) closeVoiceSettings();
  }

  const run = (label: string, work: () => Promise<void>) => {
    setWorking(label);
    setProblem(null);
    work()
      .catch((cause: unknown) => setProblem(describe(cause)))
      .finally(() => setWorking(null));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes this browser's stored pairing (localStorage) and closes the socket with the sheet
  useEffect(() => {
    const stored = readSession();
    // A pairing whose thread was never set up (or failed) finishes now, as a fresh one does.
    if (stored)
      run("Connecting to T3 Code…", async () => {
        const to = await open(stored);
        if (readBrainThread(stored.origin) === null) await finish(to);
        else setConnected(to);
      });
    return () => socketRef.current?.close();
  }, []);

  function pair(input: string) {
    run("Pairing with T3 Code…", async () => {
      const { origin } = readPairing(input);
      const support = browserSupport("tab");
      const local = !origin.startsWith("https:");
      if (local && !support.ok) throw new Error(support.line);
      if (local && (await localNetworkPermission())?.state === "prompt")
        setWorking("Chrome is asking to reach your local network: click Allow.");
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
      await finish(await open(session));
    });
  }

  const title = "Connection";
  const note =
    "lalala.talk talks from this tab straight to T3 Code on your computer. Speech stays in the browser; only your words, as text, reach your T3.";

  if (connected === null) {
    return (
      <Section title={title} note={note}>
        <PairSteps
          reach="tab"
          label="lalala.talk"
          command={PAIR_COMMAND}
          working={working}
          problem={problem}
          onPair={pair}
        />
      </Section>
    );
  }

  const { session, socket, workspace } = connected;
  const busy = working !== null;
  const threads = workspace.threads.filter((thread) => thread.projectId === projectId).slice(0, 30);
  const threadGroups: PickGroup[] = [
    { options: [{ value: NEW_THREAD, label: "New voice thread" }] },
    ...(threads.length > 0
      ? [{ label: "Threads", options: threads.map((thread) => ({ value: thread.id, label: thread.title, hidden: true })) }]
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
    run("Switching thread…", async () => {
      await follow(to);
    });
  };

  return (
    <Section title={title} note={note}>
      {notice ? <p data-lalala-settings-info="">{notice}</p> : null}
      <ConnectedRows
        ok={problem === null}
        where={[workspace.label, workspace.version ? `v${workspace.version}` : null, session.origin]
          .filter(Boolean)
          .join(" · ")}
        checked={working ?? checked}
        problem={problem}
        expiresAt={session.expiresAt}
        busy={busy}
        onRetest={() =>
          run("checking…", async () => {
            setChecked(null);
            setChecked(answered(await pingServer(socket)));
          })
        }
        onDisconnect={() => {
          socket.close();
          socketRef.current = null;
          disconnectBrain();
          setChecked(null);
          setConnected(null);
        }}
      >
        {choosing ? (
          <PickRow
            title="Project"
            description={`The T3 project the thread lives in; "${LALALA_PROJECT}" is lalala's own.`}
            label="Project"
            value={projectId}
            disabled={busy}
            groups={[{ options: workspace.projects.map((p) => ({ value: p.id, label: p.title, hidden: true })) }]}
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
      </ConnectedRows>
    </Section>
  );
}
