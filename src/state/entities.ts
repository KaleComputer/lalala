// Standalone: the one project and thread VoiceHost looks for, from the T3 bridge.
import { useMemo } from "react";
import { ENVIRONMENT_ID, PROJECT_ID, useBridge } from "../t3/bridge";
import type { OrchestrationV2ProjectedTurnItem } from "../t3/contracts";

const NO_ROWS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];

export function useProjects() {
  const workspaceRoot = useBridge((state) => state.workspaceRoot);
  return useMemo(
    () =>
      workspaceRoot === null
        ? []
        : [{ id: PROJECT_ID, environmentId: ENVIRONMENT_ID, workspaceRoot }],
    [workspaceRoot],
  );
}

export function useThreadShells() {
  const shell = useBridge((state) => state.shell);
  return useMemo(
    () =>
      shell === null
        ? []
        : [
            {
              environmentId: ENVIRONMENT_ID,
              id: shell.id,
              projectId: PROJECT_ID,
              // VoiceHost picks the thread titled "voice"; the bridge follows exactly one thread.
              title: "voice",
              archivedAt: null,
              deletedAt: null,
              createdAt: shell.createdAt,
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              runtime: { status: shell.active ? "running" : "idle" },
            },
          ],
    [shell],
  );
}

export function useThreadVisibleTurnItems(ref: unknown) {
  const rows = useBridge((state) => state.rows);
  return ref === null ? NO_ROWS : rows;
}
