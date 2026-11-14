import { useEffect, useState } from "react";

import { readBrainThread, readSession, readWorkspace, T3Socket } from "../../../src/voice/adapters/harness/t3";
import { type Brain, Section, ThreadsSection } from "../../../src/voice/VoiceSettings";

/** The models the visitor's T3 offers, read once per open page, for the new threads' picker. */
function useSiteBrain(): { readonly brain: Brain | null; readonly loading: boolean } {
  const [state, setState] = useState<{ brain: Brain | null; loading: boolean }>(() => ({
    brain: null,
    loading: readSession() !== null,
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the paired T3's models over its socket (outside React) while this page is open
  useEffect(() => {
    const session = readSession();
    if (session === null) return;
    let cancelled = false;
    const socket = new T3Socket(session);
    socket
      .connect()
      .then(() => readWorkspace(socket))
      .then((workspace) => {
        const current = readBrainThread(session.origin);
        const thread = workspace.threads.find((candidate) => candidate.id === current);
        const selection = thread?.modelSelection ?? workspace.defaultModel ?? null;
        if (!cancelled)
          setState({
            brain: {
              modelSelection: selection ? { instanceId: selection.instanceId, model: selection.model } : null,
              providers: workspace.providers,
            },
            loading: false,
          });
      })
      .catch(() => {
        if (!cancelled) setState({ brain: null, loading: false });
      })
      .finally(() => socket.close());
    return () => {
      cancelled = true;
      socket.close();
    };
  }, []);
  return state;
}

/** New threads: the model and options the brain hands to `delegate_task`. */
export function NewThreadsSection() {
  const { brain, loading } = useSiteBrain();
  if (!loading && brain === null && readSession() === null)
    return <Section title="New threads" note="Pair with your T3 Code first, under Connection." />;
  return <ThreadsSection brain={brain} loading={loading} />;
}
