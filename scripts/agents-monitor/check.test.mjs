// Live Agent Progress & Monitor: delegate step extraction, lifecycle projection, sorting,
// elapsed/completion formatting, and bridge SSE state reducer.
// Run: node --experimental-strip-types --test scripts/agents-monitor/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { INITIAL_BRIDGE_STATE, reduceBridgeState } from "../../src/t3/bridgeState.ts";
import { parseSynced } from "../../src/voice/settingsStore.ts";
import {
  createBrowserDelegateTracker,
  describeTurnItemStep,
  extractLinkedCard,
  formatDoneAt,
  formatDuration,
  formatElapsed,
  isActiveAgent,
  isBrainDelegateThread,
  isShellThreadActive,
  isShellThreadWaiting,
  normalizeRunStatus,
  projectBrainNotificationAgents,
  projectBrainPendingTasks,
  projectBrainSubagentItem,
  projectDelegateRun,
  projectDelegateShell,
  projectDelegateTurnItem,
  sortAgents,
  subagentThreadIdOf,
} from "../../src/voice/agents/model.ts";

test("describeTurnItemStep extracts concise labels for tools, waits, reasoning, and ignores bookkeeping", () => {
  assert.equal(describeTurnItemStep({ type: "user_message", text: "hi" }), null);
  assert.equal(describeTurnItemStep({ type: "checkpoint" }), null);
  assert.equal(describeTurnItemStep({ type: "reasoning" }), "Thinking…");
  assert.equal(describeTurnItemStep({ type: "assistant_message", streaming: true }), "Writing reply…");
  assert.equal(describeTurnItemStep({ type: "assistant_message", streaming: false }), null);

  assert.equal(
    describeTurnItemStep({
      type: "tool_call",
      toolName: "run_command",
      arguments: { toolSummary: "Run site typecheck" },
    }),
    "Run site typecheck",
  );
  assert.equal(
    describeTurnItemStep({
      type: "command_execution",
      command: "npm run check\necho done",
    }),
    "Running npm run check",
  );
  assert.equal(
    describeTurnItemStep({
      type: "tool_call",
      toolName: "read_file",
      path: "src/voice/VoiceBar.tsx",
    }),
    "Reading VoiceBar.tsx",
  );
  assert.equal(
    describeTurnItemStep({
      type: "file_change",
      filePath: "src/t3/bridge.ts",
    }),
    "Editing bridge.ts",
  );
  assert.equal(
    describeTurnItemStep({
      type: "web_search",
      query: "vite sse reconnect",
    }),
    "Searching vite sse reconnect",
  );
  assert.equal(
    describeTurnItemStep({
      type: "secret_request",
      secretStatus: "pending",
      label: "API Key",
    }),
    "Waiting for secret: API Key",
  );
  assert.equal(
    describeTurnItemStep({
      type: "secret_request",
      secretStatus: "saved",
      label: "API Key",
    }),
    null,
  );
  assert.equal(
    describeTurnItemStep({
      type: "error",
      status: "running",
      retry: { attempt: 1 },
    }),
    "Retrying…",
  );
});

test("delegate lifecycle transitions cleanly from running -> waiting -> running -> completed", () => {
  const brainId = "brain-1";
  const shellStart = {
    id: "worker-1",
    title: "Update website copy",
    activeRunId: "run-1",
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:02.000Z",
    lineage: { relationshipToParent: "subagent", rootThreadId: brainId },
  };
  assert.equal(isBrainDelegateThread(shellStart, brainId), true);
  assert.equal(isBrainDelegateThread(shellStart, "other-brain"), false);

  let agent = projectDelegateShell(undefined, shellStart, "http://127.0.0.1:3773/env/worker-1");
  assert.equal(agent.status, "running");
  assert.equal(agent.title, "Update website copy");
  assert.equal(agent.completedAt, null);
  assert.equal(isActiveAgent(agent), true);

  agent = projectDelegateRun(agent, {
    id: "run-1",
    status: "running",
    workStartedAt: "2026-11-22T10:00:01.000Z",
  });
  assert.equal(agent.startedAt, "2026-11-22T10:00:01.000Z");

  agent = projectDelegateTurnItem(
    agent,
    {
      type: "tool_call",
      runId: "run-1",
      toolSummary: "Edit hero heading",
      updatedAt: "2026-11-22T10:00:15.000Z",
    },
    "run-1",
  );
  assert.equal(agent.step, "Edit hero heading");
  assert.equal(agent.status, "running");

  // Pending secret switches status to waiting.
  agent = projectDelegateTurnItem(
    agent,
    {
      type: "secret_request",
      runId: "run-1",
      secretStatus: "pending",
      label: "Deploy Token",
      updatedAt: "2026-11-22T10:00:20.000Z",
    },
    "run-1",
  );
  assert.equal(agent.status, "waiting");
  assert.equal(agent.step, "Waiting for secret: Deploy Token");

  // Answering the secret resumes running.
  agent = projectDelegateTurnItem(
    agent,
    {
      type: "secret_request",
      runId: "run-1",
      secretStatus: "saved",
      label: "Deploy Token",
      updatedAt: "2026-11-22T10:00:25.000Z",
    },
    "run-1",
  );
  assert.equal(agent.status, "running");
  assert.equal(agent.step, "Resuming…");

  // Another concrete tool step lands, then shell signals activeRunId === null.
  agent = projectDelegateTurnItem(
    agent,
    {
      type: "command_execution",
      runId: "run-1",
      toolSummary: "Run npm run check",
      updatedAt: "2026-11-22T10:00:40.000Z",
    },
    "run-1",
  );
  agent = projectDelegateShell(
    agent,
    {
      ...shellStart,
      activeRunId: null,
      updatedAt: "2026-11-22T10:01:05.000Z",
    },
    "http://127.0.0.1:3773/env/worker-1",
  );
  assert.equal(agent.status, "completed");
  assert.equal(agent.completedAt, "2026-11-22T10:01:05.000Z");
  assert.equal(agent.step, "Run npm run check");
  assert.equal(isActiveAgent(agent), false);
});

test("projectBrainNotificationAgents backfills finished runs, attaches [about: card], and preserves active runs", () => {
  const existing = new Map([
    [
      "active-1",
      {
        id: "active-1",
        title: "Live worker",
        status: "running",
        step: "Editing App.tsx",
        startedAt: "2026-11-22T12:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-11-22T12:00:10.000Z",
        link: null,
        card: null,
      },
    ],
  ]);

  const rows = [
    // Older notification for active-1 must NOT downgrade it to completed.
    {
      item: {
        id: "n-old",
        type: "notification",
        text: "",
        streaming: false,
        parentItemId: null,
        startedAt: "2026-11-22T11:50:00.000Z",
        updatedAt: "2026-11-22T11:50:00.000Z",
        runId: "r-old",
        trigger: { kind: "delegated", threadId: "active-1", outcome: "completed", lead: "Old run" },
      },
    },
    // Completed delegate with linked card in brain's reply.
    {
      item: {
        id: "n-done",
        type: "notification",
        text: "",
        streaming: false,
        parentItemId: null,
        startedAt: "2026-11-22T11:58:00.000Z",
        updatedAt: "2026-11-22T11:58:00.000Z",
        runId: "r-done",
        trigger: { kind: "delegated", threadId: "done-1", outcome: "completed", lead: "Updated card" },
      },
    },
    {
      item: {
        id: "a-done",
        type: "assistant_message",
        text: "[new topic] [about: roadmap-card] Worker updated the roadmap.",
        streaming: false,
        parentItemId: null,
        startedAt: "2026-11-22T11:58:02.000Z",
        updatedAt: "2026-11-22T11:58:02.000Z",
        runId: "r-done",
        trigger: null,
      },
    },
    // Failed delegate.
    {
      item: {
        id: "n-fail",
        type: "notification",
        text: "",
        streaming: false,
        parentItemId: null,
        startedAt: "2026-11-22T11:55:00.000Z",
        updatedAt: "2026-11-22T11:55:00.000Z",
        runId: "r-fail",
        trigger: { kind: "delegated", threadId: "fail-1", outcome: "failed", lead: "Build failed" },
      },
    },
  ];

  const merged = projectBrainNotificationAgents(existing, rows, {
    titleOf: (id) => (id === "done-1" ? "Roadmap worker" : id === "fail-1" ? "Build worker" : null),
    linkOf: (id) => `http://127.0.0.1:3773/env/${id}`,
  });

  assert.equal(merged.get("active-1")?.status, "running");
  assert.equal(merged.get("done-1")?.status, "completed");
  assert.equal(merged.get("done-1")?.title, "Roadmap worker");
  assert.equal(merged.get("done-1")?.card, "roadmap-card");
  assert.equal(merged.get("done-1")?.link, "http://127.0.0.1:3773/env/done-1");
  assert.equal(merged.get("fail-1")?.status, "failed");
  assert.equal(merged.get("fail-1")?.step, "Build failed");

  const sorted = sortAgents(merged.values());
  assert.deepEqual(
    sorted.map((a) => a.id),
    ["active-1", "done-1", "fail-1"],
  );
});

test("formatting helpers and bridge SSE reducer handle agents events cleanly", () => {
  assert.equal(extractLinkedCard("[about: `my-card`] done"), "my-card");
  assert.equal(normalizeRunStatus("preparing"), "running");
  assert.equal(normalizeRunStatus("interrupted"), "cancelled");
  assert.equal(normalizeRunStatus("awaiting_approval"), "waiting");

  assert.equal(formatElapsed("2026-11-22T10:00:00.000Z", Date.parse("2026-11-22T10:00:42.000Z")), "42s");
  assert.equal(formatElapsed("2026-11-22T10:00:00.000Z", Date.parse("2026-11-22T10:03:07.000Z")), "3m 07s");
  assert.equal(formatElapsed("2026-11-22T10:00:00.000Z", Date.parse("2026-11-22T11:05:00.000Z")), "1h 05m");
  assert.equal(
    formatDuration("2026-11-22T10:00:00.000Z", "2026-11-22T10:01:25.000Z"),
    "1m 25s",
  );
  assert.equal(formatDuration("2026-11-22T10:00:00.000Z", null), null);

  const localDay = new Date(2026, 10, 22, 14, 32, 0);
  const localNow = new Date(2026, 10, 22, 15, 0, 0);
  assert.equal(formatDoneAt(localDay.toISOString(), localNow), "done at 14:32");

  const earlierDay = new Date(2026, 10, 20, 9, 5, 0);
  assert.match(formatDoneAt(earlierDay.toISOString(), localNow), /^done \w+ 09:05$/);

  const sampleAgent = {
    id: "w1",
    title: "Refactor bridge",
    status: "running",
    step: "Editing t3bridge.mjs",
    startedAt: "2026-11-22T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-11-22T10:00:05.000Z",
    link: null,
    card: null,
  };
  const afterHello = reduceBridgeState(INITIAL_BRIDGE_STATE, {
    type: "hello",
    connected: true,
    error: null,
    workspaceRoot: "/tmp/demo",
    shell: null,
    rows: [],
    agents: [sampleAgent],
  });
  assert.equal(afterHello.connected, true);
  assert.equal(afterHello.agents.length, 1);
  assert.equal(afterHello.agents[0]?.step, "Editing t3bridge.mjs");

  const doneAgent = {
    ...sampleAgent,
    status: "completed",
    completedAt: "2026-11-22T10:00:45.000Z",
    updatedAt: "2026-11-22T10:00:45.000Z",
  };
  const afterUpdate = reduceBridgeState(afterHello, {
    type: "agents",
    agents: [doneAgent],
  });
  assert.equal(afterUpdate.connected, true);
  assert.equal(afterUpdate.agents[0]?.status, "completed");
  assert.equal(afterUpdate.agents[0]?.completedAt, "2026-11-22T10:00:45.000Z");

  // Nameless historical notifications without title or lead are omitted (never shown as "Background worker").
  const nameless = projectBrainNotificationAgents(
    new Map(),
    [
      {
        item: {
          id: "n-anon",
          type: "notification",
          text: "",
          streaming: false,
          parentItemId: null,
          startedAt: "2026-11-22T11:55:00.000Z",
          updatedAt: "2026-11-22T11:55:00.000Z",
          runId: "r-anon",
          trigger: { kind: "delegated", threadId: "anon-1", outcome: "completed" },
        },
      },
    ],
    {
      titleOf: () => null,
      linkOf: () => null,
    },
  );
  assert.equal(nameless.size, 0);

  // Labs flag defaults off in local app mode, on in site mode (lalala.talk), and honors explicit false.
  assert.equal(parseSynced({})?.labs.agentsMonitor, false);
  assert.equal(parseSynced({ labs: { agentsMonitor: true } })?.labs.agentsMonitor, true);
  assert.equal(parseSynced({ labs: { agentsMonitor: "yes" } })?.labs.agentsMonitor, false);
  assert.equal(parseSynced({}, { defaultAgentsMonitor: true })?.labs.agentsMonitor, true);
  assert.equal(parseSynced({ labs: {} }, { defaultAgentsMonitor: true })?.labs.agentsMonitor, true);
  assert.equal(
    parseSynced({ labs: { agentsMonitor: false } }, { defaultAgentsMonitor: true })?.labs.agentsMonitor,
    false,
  );
});

test("background-waiting subagents and brain subagent turn items stay active until completion", () => {
  const brainId = "brain-claude";
  const childId = "thread:delegated-task:demo-worker-1";
  const itemId = "turn-item:delegated-task:demo-worker-1";

  assert.equal(subagentThreadIdOf({ id: itemId }), childId);
  assert.equal(subagentThreadIdOf({ id: "other", childThreadId: childId }), childId);

  // Direct subagent matched by parentThreadId (even when rootThreadId differs or is omitted).
  assert.equal(
    isBrainDelegateThread(
      {
        id: childId,
        parentThreadId: brainId,
        relationshipToParent: "subagent",
      },
      brainId,
    ),
    true,
  );

  // A delegate waiting on a background shell command has activeRunId: null, status: "waiting",
  // and non-empty pendingBackgroundTasks — must stay active, not flip to completed.
  const waitingThread = {
    id: childId,
    title: "Monitor test worker 1",
    activeRunId: null,
    status: "waiting",
    createdAt: "2026-11-22T21:59:24.000Z",
    updatedAt: "2026-11-22T21:59:33.000Z",
    pendingBackgroundTasks: [
      { taskId: "bg-1", kind: "command", description: "Sleep for 180 seconds in background", awaited: true },
    ],
    lineage: { relationshipToParent: "subagent", rootThreadId: brainId },
  };
  assert.equal(isShellThreadWaiting(waitingThread), true);
  assert.equal(isShellThreadActive(waitingThread), true);

  let agent = projectDelegateShell(undefined, waitingThread, "https://t3.example/env/demo-worker-1");
  assert.equal(agent.status, "waiting");
  assert.equal(agent.completedAt, null);
  assert.equal(agent.step, "Sleep for 180 seconds in background");
  assert.equal(isActiveAgent(agent), true);

  // Completed turn run while thread is still waiting on background task must NOT downgrade to completed.
  agent = projectDelegateRun(
    agent,
    { id: "run-1", status: "completed", completedAt: "2026-11-22T21:59:33.000Z" },
    "2026-11-22T21:59:34.000Z",
    { threadWaiting: true },
  );
  assert.equal(agent.status, "waiting");
  assert.equal(agent.completedAt, null);

  // Brain `type: "subagent"` turn item projects immediately and transitions cleanly to completed.
  const ctx = {
    titleOf: () => null,
    linkOf: (id) => `https://t3.example/env/${encodeURIComponent(id)}`,
  };
  let fromItem = projectBrainSubagentItem(
    undefined,
    {
      id: itemId,
      type: "subagent",
      status: "running",
      title: "Monitor test worker 1",
      startedAt: "2026-11-22T21:59:24.000Z",
      updatedAt: "2026-11-22T21:59:24.000Z",
    },
    ctx,
  );
  assert.ok(fromItem);
  assert.equal(fromItem.id, childId);
  assert.equal(fromItem.status, "running");
  assert.equal(fromItem.title, "Monitor test worker 1");
  assert.equal(fromItem.link, `https://t3.example/env/${encodeURIComponent(childId)}`);

  fromItem = projectBrainSubagentItem(
    fromItem,
    {
      id: itemId,
      type: "subagent",
      status: "completed",
      title: "Monitor test worker 1",
      completedAt: "2026-11-22T22:02:30.000Z",
      updatedAt: "2026-11-22T22:02:30.000Z",
    },
    ctx,
  );
  assert.ok(fromItem);
  assert.equal(fromItem.status, "completed");
  assert.equal(fromItem.completedAt, "2026-11-22T22:02:30.000Z");

  const pending = projectBrainPendingTasks(
    new Map(),
    [{ taskId: itemId, kind: "subagent", description: "Monitor test worker 1", childThreadId: childId }],
    ctx,
  );
  assert.equal(pending.activeIds.has(childId), true);
  assert.equal(pending.agents.get(childId)?.status, "running");
});

test("createBrowserDelegateTracker tracks live subagents, shell updates, child streams, links, and completion", () => {
  const brainId = "thread:project:demo:brain";
  const worker1 = "thread:delegated-task:worker-1";
  const worker2 = "thread:delegated-task:worker-2";

  const streams = [];
  const socket = {
    stream(tag, payload, onChunk) {
      const entry = { tag, payload, onChunk, stopped: false };
      streams.push(entry);
      return {
        done: new Promise(() => {}),
        stop() {
          entry.stopped = true;
        },
      };
    },
  };

  let envId = null;
  const titles = new Map();
  const emitted = [];
  const tracker = createBrowserDelegateTracker({
    brainThreadId: brainId,
    titleOf: (id) => titles.get(id) ?? null,
    linkOf: (id) => (envId ? `https://t3.example/${envId}/${encodeURIComponent(id)}` : null),
    onTitle: (id, title) => titles.set(id, title),
    onAgents: (list) => emitted.push(list),
  });

  // 1) Brain snapshot arrives with an active subagent turn item + pendingBackgroundTasks.
  tracker.takeBrainSnapshot(socket, {
    thread: {
      pendingBackgroundTasks: [
        {
          taskId: "turn-item:delegated-task:worker-1",
          kind: "subagent",
          description: "Monitor test worker 1",
          childThreadId: worker1,
        },
      ],
    },
    visibleTurnItems: [
      {
        item: {
          id: "turn-item:delegated-task:worker-1",
          type: "subagent",
          status: "running",
          title: "Monitor test worker 1",
          startedAt: "2026-11-22T21:59:24.000Z",
          updatedAt: "2026-11-22T21:59:24.000Z",
        },
      },
    ],
  });

  assert.equal(tracker.view().length, 1);
  assert.equal(tracker.view()[0]?.id, worker1);
  assert.equal(tracker.view()[0]?.status, "running");
  assert.equal(tracker.view()[0]?.link, null);
  assert.equal(
    streams.some((s) => s.tag === "orchestration.subscribeThread" && s.payload.threadId === worker1),
    true,
  );

  // 2) server.getConfig returns environmentId -> refreshLinks backfills clickable link.
  envId = "env-1";
  tracker.refreshLinks();
  assert.equal(tracker.view()[0]?.link, `https://t3.example/env-1/${encodeURIComponent(worker1)}`);

  // 3) Live shell subscription opens and delivers a second active delegate.
  tracker.startShell(socket, { shellThreadFamilies: true, shellOlderSettled: true });
  const shellStream = streams.find((s) => s.tag === "orchestration.subscribeShell");
  assert.ok(shellStream);
  assert.deepEqual(shellStream.payload, { omitIdleSubagents: true, omitOlderSettled: true });

  shellStream.onChunk({
    kind: "thread.updated",
    location: "active",
    thread: {
      id: worker2,
      title: "Monitor test worker 2",
      activeRunId: "run-w2",
      createdAt: "2026-11-22T21:59:25.000Z",
      updatedAt: "2026-11-22T21:59:26.000Z",
      lineage: { relationshipToParent: "subagent", rootThreadId: brainId },
    },
  });
  assert.equal(tracker.view().filter(isActiveAgent).length, 2);

  // 4) Child stream for worker-2 delivers a live tool step and title rename.
  const child2Stream = streams.find(
    (s) => s.tag === "orchestration.subscribeThread" && s.payload.threadId === worker2,
  );
  assert.ok(child2Stream);
  child2Stream.onChunk({
    kind: "event",
    event: {
      type: "turn-item.updated",
      payload: {
        type: "tool_call",
        runId: "run-w2",
        toolSummary: "Running checks",
        updatedAt: "2026-11-22T21:59:30.000Z",
      },
    },
  });
  child2Stream.onChunk({
    kind: "event",
    event: {
      type: "thread.updated",
      payload: { id: worker2, title: "Checks worker" },
    },
  });
  const w2 = tracker.view().find((a) => a.id === worker2);
  assert.equal(w2?.step, "Running checks");
  assert.equal(w2?.title, "Checks worker");

  // 5) Worker-1 waits on background command (activeRunId: null, status: "waiting"): stays active!
  const child1Stream = streams.find(
    (s) => s.tag === "orchestration.subscribeThread" && s.payload.threadId === worker1,
  );
  assert.ok(child1Stream);
  child1Stream.onChunk({
    kind: "snapshot",
    projection: {
      thread: {
        id: worker1,
        title: "Monitor test worker 1",
        activeRunId: null,
        status: "waiting",
        pendingBackgroundTasks: [{ taskId: "bg-1", kind: "command", description: "Sleep 180s" }],
      },
      runs: [{ id: "run-w1", status: "completed", completedAt: "2026-11-22T21:59:33.000Z" }],
      turnItems: [],
    },
  });
  assert.equal(tracker.view().find((a) => a.id === worker1)?.status, "waiting");
  assert.equal(child1Stream.stopped, false);

  // 6) Worker-2 finishes via shell (location !== "active") -> leaves Active and stops child stream.
  shellStream.onChunk({
    kind: "thread.updated",
    location: "idle",
    thread: { id: worker2, updatedAt: "2026-11-22T22:00:10.000Z" },
  });
  assert.equal(tracker.view().find((a) => a.id === worker2)?.status, "completed");
  assert.equal(child2Stream.stopped, true);

  // 7) Worker-1 finishes via brain subagent item + pendingBackgroundTasks update -> clears Active!
  tracker.takeBrainTurnItem(socket, {
    id: "turn-item:delegated-task:worker-1",
    type: "subagent",
    status: "completed",
    title: "Monitor test worker 1",
    completedAt: "2026-11-22T22:02:30.000Z",
    updatedAt: "2026-11-22T22:02:30.000Z",
  });
  tracker.takeBrainThreadUpdated(socket, { pendingBackgroundTasks: [] });
  assert.equal(tracker.view().filter(isActiveAgent).length, 0);
  assert.equal(tracker.view().find((a) => a.id === worker1)?.status, "completed");
  assert.equal(child1Stream.stopped, true);
  assert.ok(emitted.length > 0);

  // 8) Reset stops shell subscription and clears tracked state.
  tracker.reset();
  assert.equal(shellStream.stopped, true);
  assert.equal(tracker.view().length, 0);
});
