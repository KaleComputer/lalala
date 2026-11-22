import type { AgentRun } from "../voice/agents/model";
import type { VoiceBrainContext } from "../voice/brainCompaction";
import type { Inbox } from "../voice/inbox/capture";
import type { OrchestrationV2ProjectedTurnItem } from "./contracts";

export type BridgeShell = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly active: boolean;
};

/** A secret card (T3's `request_secret`) waiting in some thread. Never the value. */
export type SecretAsk = {
  readonly threadId: string;
  readonly turnItemId: string;
  readonly thread: string;
  readonly label: string;
  readonly reason: string;
  readonly placeholder: string | null;
  readonly file: boolean;
};

export type BridgeState = {
  readonly connected: boolean;
  readonly error: string | null;
  readonly workspaceRoot: string | null;
  readonly shell: BridgeShell | null;
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly context: VoiceBrainContext | null;
  readonly asks: ReadonlyArray<SecretAsk>;
  /** Live and recently completed delegate runs of the brain thread. */
  readonly agents: ReadonlyArray<AgentRun>;
  /** The away inbox (Labs), as the harness keeps it; `digest`: the app can send its digest. */
  readonly inbox: Inbox & { readonly digest?: boolean };
};

export type BridgeEvent = {
  readonly type: string;
  readonly connected?: boolean;
  readonly error?: string | null;
  readonly workspaceRoot?: string | null;
  readonly shell?: BridgeShell | null;
  readonly rows?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly row?: OrchestrationV2ProjectedTurnItem;
  readonly asks?: ReadonlyArray<SecretAsk>;
  readonly agents?: ReadonlyArray<AgentRun>;
  readonly value?: boolean;
  readonly context?: VoiceBrainContext | null;
  readonly inbox?: BridgeState["inbox"];
};

export const INITIAL_BRIDGE_STATE: BridgeState = {
  connected: false,
  error: null,
  workspaceRoot: null,
  shell: null,
  rows: [],
  context: null,
  asks: [],
  agents: [],
  inbox: { items: [], digestAt: null },
};

/** Pure reducer for SSE events (`hello`, `agents`, `row`, `asks`, `context`, `inbox`, `active`). */
export function reduceBridgeState(current: BridgeState, event: BridgeEvent): BridgeState {
  if (event.type === "hello") {
    return {
      connected: event.connected ?? false,
      error: event.error ?? null,
      workspaceRoot: event.workspaceRoot ?? null,
      shell: event.shell ?? null,
      rows: event.rows ?? [],
      context: event.context ?? null,
      asks: event.asks ?? [],
      agents: event.agents ?? [],
      inbox: event.inbox ?? current.inbox,
    };
  }
  if (event.type === "agents") {
    return { ...current, agents: event.agents ?? [] };
  }
  if (event.type === "inbox") {
    return { ...current, inbox: event.inbox ?? current.inbox };
  }
  if (event.type === "row" && event.row) {
    const rows = current.rows.filter((row) => row.item.id !== event.row!.item.id);
    return { ...current, rows: [...rows, event.row] };
  }
  if (event.type === "asks") {
    return { ...current, asks: event.asks ?? [] };
  }
  if (event.type === "context") {
    return { ...current, context: event.context ?? null };
  }
  if (event.type === "active" && current.shell !== null && typeof event.value === "boolean") {
    return { ...current, shell: { ...current.shell, active: event.value } };
  }
  return current;
}
