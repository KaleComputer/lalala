// Live compaction turn items and `/compact` run context derivation (shared by vite/t3bridge.mjs
// and src/voice/adapters/harness/browser.ts).
// Run: node --experimental-strip-types --test scripts/compaction/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { test } from "node:test";

import {
  collectCompactionItems,
  deriveBrainContext,
  isCompactionMessage,
  slimCompactionItem,
  slimRun,
} from "../../src/voice/adapters/harness/compaction.ts";

const usage = {
  usedTokens: 240_000,
  maxTokens: 1_000_000,
  promptCacheTtlMs: 300_000,
  updatedAt: "2026-11-22T20:00:00.000Z",
};

test("live running compaction turn item sets compacting and compactStartedAt for any provider", () => {
  const runs = new Map([
    [
      "r1",
      slimRun({
        id: "r1",
        status: "running",
        userMessageId: "m-normal",
        workStartedAt: "2026-11-22T20:01:00.000Z",
      }),
    ],
  ]);
  const compactionItems = new Map([
    [
      "c1",
      slimCompactionItem({
        id: "c1",
        type: "compaction",
        runId: "r1",
        status: "running",
        startedAt: "2026-11-22T20:01:05.000Z",
        completedAt: null,
        updatedAt: "2026-11-22T20:01:05.000Z",
      }),
    ],
  ]);

  const during = deriveBrainContext({
    usage,
    claude: false,
    runs,
    compactions: new Set(),
    compactionItems,
  });
  assert.deepEqual(during, {
    usedTokens: 240_000,
    maxTokens: 1_000_000,
    reportedAt: Date.parse("2026-11-22T20:00:00.000Z"),
    cacheTtlMs: 300_000,
    claude: false,
    compacting: true,
    compactedAt: null,
    compactStartedAt: Date.parse("2026-11-22T20:01:05.000Z"),
    compactTookMs: [],
  });

  // Once the compaction item finishes mid-turn, compacting clears immediately even while r1 still replies.
  compactionItems.set(
    "c1",
    slimCompactionItem({
      id: "c1",
      type: "compaction",
      runId: "r1",
      status: "completed",
      startedAt: "2026-11-22T20:01:05.000Z",
      completedAt: "2026-11-22T20:01:23.000Z",
      updatedAt: "2026-11-22T20:01:23.000Z",
    }),
  );

  const after = deriveBrainContext({
    usage,
    claude: false,
    runs,
    compactions: new Set(),
    compactionItems,
  });
  assert.equal(after?.compacting, false);
  assert.equal(after?.compactStartedAt, null);
  assert.equal(after?.compactedAt, Date.parse("2026-11-22T20:01:23.000Z"));
  assert.deepEqual(after?.compactTookMs, [18_000]);
});

test("live compaction turn item works even before tokenUsage is reported", () => {
  const runs = new Map([
    [
      "r1",
      slimRun({
        id: "r1",
        status: "running",
        userMessageId: "m1",
        startedAt: "2026-11-22T20:02:00.000Z",
      }),
    ],
  ]);
  const compactionItems = new Map([
    [
      "c1",
      slimCompactionItem({
        id: "c1",
        type: "compaction",
        runId: "r1",
        status: "running",
        startedAt: "2026-11-22T20:02:02.000Z",
        updatedAt: "2026-11-22T20:02:02.000Z",
      }),
    ],
  ]);

  const running = deriveBrainContext({
    usage: null,
    claude: false,
    runs,
    compactions: new Set(),
    compactionItems,
  });
  assert.equal(running?.compacting, true);
  assert.equal(running?.compactStartedAt, Date.parse("2026-11-22T20:02:02.000Z"));
  assert.equal(running?.reportedAt, 0);

  // Failed/cancelled compaction clears compacting without recording a completed compaction.
  compactionItems.set(
    "c1",
    slimCompactionItem({
      id: "c1",
      type: "compaction",
      runId: "r1",
      status: "failed",
      startedAt: "2026-11-22T20:02:02.000Z",
      updatedAt: "2026-11-22T20:02:09.000Z",
    }),
  );
  const failed = deriveBrainContext({
    usage: null,
    claude: false,
    runs,
    compactions: new Set(),
    compactionItems,
  });
  assert.equal(failed, null);
});

test("running compaction item does not stay stuck once its run has ended", () => {
  const runs = new Map([
    [
      "r1",
      slimRun({
        id: "r1",
        status: "interrupted",
        userMessageId: "m1",
        startedAt: "2026-11-22T20:03:00.000Z",
        completedAt: "2026-11-22T20:03:10.000Z",
      }),
    ],
  ]);
  const compactionItems = new Map([
    [
      "c1",
      slimCompactionItem({
        id: "c1",
        type: "compaction",
        runId: "r1",
        status: "running",
        startedAt: "2026-11-22T20:03:01.000Z",
        updatedAt: "2026-11-22T20:03:01.000Z",
      }),
    ],
  ]);

  const ctx = deriveBrainContext({
    usage,
    claude: false,
    runs,
    compactions: new Set(),
    compactionItems,
  });
  assert.equal(ctx?.compacting, false);
  assert.equal(ctx?.compactStartedAt, null);
});

test("explicit /compact run and compaction item stay aligned without double-counting compactTookMs", () => {
  const msg = { id: "m-compact", role: "user", text: " /compact ", attachments: [] };
  assert.equal(isCompactionMessage(msg), true);
  assert.equal(
    isCompactionMessage({ id: "m-attach", role: "user", text: "/compact", attachments: [{}] }),
    false,
  );

  const compactions = new Set([msg.id]);
  const runs = new Map([
    [
      "r-compact",
      slimRun({
        id: "r-compact",
        status: "running",
        userMessageId: msg.id,
        workStartedAt: "2026-11-22T20:05:00.000Z",
      }),
    ],
  ]);
  const compactionItems = new Map([
    [
      "c-compact",
      slimCompactionItem({
        id: "c-compact",
        type: "compaction",
        runId: "r-compact",
        status: "running",
        startedAt: "2026-11-22T20:05:01.000Z",
        updatedAt: "2026-11-22T20:05:01.000Z",
      }),
    ],
  ]);

  const active = deriveBrainContext({ usage, claude: true, runs, compactions, compactionItems });
  assert.equal(active?.compacting, true);
  // Keeps the earliest active start so the defrag clock never jumps forward mid-run.
  assert.equal(active?.compactStartedAt, Date.parse("2026-11-22T20:05:00.000Z"));

  compactionItems.set(
    "c-compact",
    slimCompactionItem({
      id: "c-compact",
      type: "compaction",
      runId: "r-compact",
      status: "completed",
      startedAt: "2026-11-22T20:05:01.000Z",
      completedAt: "2026-11-22T20:05:26.000Z",
      updatedAt: "2026-11-22T20:05:26.000Z",
    }),
  );
  runs.set(
    "r-compact",
    slimRun({
      id: "r-compact",
      status: "completed",
      userMessageId: msg.id,
      workStartedAt: "2026-11-22T20:05:00.000Z",
      completedAt: "2026-11-22T20:05:27.000Z",
    }),
  );

  // Add an older /compact run without a compaction item to verify oldest-first ordering.
  compactions.add("m-older");
  runs.set(
    "r-older",
    slimRun({
      id: "r-older",
      status: "completed",
      userMessageId: "m-older",
      requestedAt: "2026-11-22T19:00:00.000Z",
      completedAt: "2026-11-22T19:00:12.000Z",
    }),
  );

  const done = deriveBrainContext({ usage, claude: true, runs, compactions, compactionItems });
  assert.equal(done?.compacting, false);
  assert.equal(done?.compactStartedAt, null);
  assert.equal(done?.compactedAt, Date.parse("2026-11-22T20:05:27.000Z"));
  assert.deepEqual(done?.compactTookMs, [12_000, 25_000]);
});

test("collectCompactionItems keeps local compaction items and ignores inherited/non-compaction rows", () => {
  const items = collectCompactionItems([
    {
      visibility: "inherited",
      item: { id: "c-parent", type: "compaction", runId: "r0", status: "running" },
    },
    {
      visibility: "local",
      item: { id: "a1", type: "assistant_message", runId: "r1", status: "completed" },
    },
    {
      visibility: "local",
      item: {
        id: "c-local",
        type: "compaction",
        runId: "r1",
        status: "running",
        startedAt: "2026-11-22T20:10:00.000Z",
      },
    },
  ]);

  assert.deepEqual([...items.keys()], ["c-local"]);
  assert.equal(items.get("c-local")?.status, "running");
});

test("both vite/t3bridge.mjs and browser harness wire live compaction turn items through deriveBrainContext", () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  for (const rel of ["vite/t3bridge.mjs", "src/voice/adapters/harness/browser.ts"]) {
    const source = NodeFS.readFileSync(NodePath.join(root, rel), "utf8");
    assert.match(source, /deriveBrainContext/, `${rel} should derive context via deriveBrainContext`);
    assert.match(
      source,
      /collectCompactionItems\(projection\.visibleTurnItems\)/,
      `${rel} should hydrate compactionItems from snapshot visibleTurnItems`,
    );
    assert.match(
      source,
      /payload\.type === "compaction"/,
      `${rel} should react to live turn-item.updated compaction items`,
    );
  }
});
