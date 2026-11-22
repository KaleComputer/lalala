// Settle action (harness + HTTP fallback) and Follow helpers (tags + HMR path matching).
// Run: node --experimental-strip-types --test scripts/settle-follow/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import { matchCardByModulePath, takeAboutCards, takeFocus } from "../../src/voice/follow.ts";
import { applyInboxChange, captureInbox, EMPTY_INBOX } from "../../src/voice/inbox/capture.ts";
import { settleBrainThread } from "../../src/voice/settleThread.ts";
import { readCanvasLayout, saveCanvasCards } from "../../vite/canvasLayout.ts";

test("settleBrainThread uses harness settle when present, else POSTs /__lalala/t3/settle", async () => {
  const logs = [];
  let harnessCalled = 0;
  const okHarness = await settleBrainThread("user", {
    harnessSettle: async () => {
      harnessCalled += 1;
    },
    log: (who, type, data) => logs.push({ who, type, data }),
  });
  assert.equal(okHarness, true);
  assert.equal(harnessCalled, 1);
  assert.deepEqual(logs.at(-1), { who: "user", type: "thread.settle", data: { ok: true } });

  const calls = [];
  const okHttp = await settleBrainThread("brain", {
    fetchFn: async (url, init) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    log: (who, type, data) => logs.push({ who, type, data }),
  });
  assert.equal(okHttp, true);
  assert.deepEqual(calls, [{ url: "/__lalala/t3/settle", method: "POST" }]);
  assert.deepEqual(logs.at(-1), { who: "brain", type: "thread.settle", data: { ok: true } });

  const failHttp = await settleBrainThread("user", {
    fetchFn: async () => new Response(JSON.stringify({ error: "not connected" }), { status: 502 }),
    log: (who, type, data) => logs.push({ who, type, data }),
  });
  assert.equal(failHttp, false);
  assert.equal(logs.at(-1).data.ok, false);
  assert.match(logs.at(-1).data.error, /not connected/);
});

test("[settle] tag is stripped from away inbox summaries like [tidy]", () => {
  const inbox = captureInbox(
    EMPTY_INBOX,
    [
      {
        item: {
          id: "t1",
          type: "notification",
          text: "",
          streaming: false,
          parentItemId: null,
          startedAt: "2026-11-22T20:00:00Z",
          updatedAt: "2026-11-22T20:00:00Z",
          runId: "r1",
          trigger: { kind: "delegated", threadId: "th1", outcome: "completed", lead: "Done" },
        },
      },
      {
        item: {
          id: "a1",
          type: "assistant_message",
          text: "[new topic] [settle] [tidy] Worker finished.",
          streaming: false,
          parentItemId: null,
          startedAt: "2026-11-22T20:00:01Z",
          updatedAt: "2026-11-22T20:00:01Z",
          runId: "r1",
          trigger: null,
        },
      },
    ],
    { titleOf: () => "Worker", linkOf: () => null },
  );
  assert.equal(inbox.items[0]?.summary, "Worker finished.");
  assert.equal(applyInboxChange(inbox, { heard: "all" }).items[0]?.heard, true);
});

test("takeAboutCards, takeFocus, and matchCardByModulePath extract updated cards cleanly", () => {
  assert.deepEqual(takeAboutCards("[new topic] [about: release-slides] Updated slide 3."), [
    "release-slides",
  ]);
  assert.deepEqual(takeFocus("[focus: demo-board] Opening it now."), {
    text: "Opening it now.",
    cards: ["demo-board"],
  });

  const cards = [
    { id: "release-slides", title: "Release Slides" },
    { id: "status-board", title: "Status Board" },
  ];
  assert.equal(matchCardByModulePath("/@fs/tmp/cards/ReleaseSlides.tsx", cards), "release-slides");
  assert.equal(matchCardByModulePath("/@fs/tmp/cards/releaseSlides/slides.json", cards), "release-slides");
  assert.equal(matchCardByModulePath("/@fs/tmp/cards/statusBoardData.ts", cards), "status-board");
  assert.equal(matchCardByModulePath("/@fs/tmp/cards/index.tsx", cards), null);
});

test("canvasLayout merges cross-device follow signals (newest wins, invalid ignored)", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-follow-layout-"));
  const prev = process.env.LALALA_CANVAS_FILE;
  process.env.LALALA_CANVAS_FILE = NodePath.join(dir, "canvas.json");
  try {
    const first = saveCanvasCards({}, undefined, undefined, undefined, undefined, {
      canvas: "c2",
      card: "release-slides",
      at: 2000,
      by: "phone",
    });
    assert.deepEqual(first.follow, {
      canvas: "c2",
      card: "release-slides",
      at: 2000,
      by: "phone",
    });

    // Stale follow signal must not overwrite newer one.
    const stale = saveCanvasCards({}, undefined, undefined, undefined, undefined, {
      canvas: "main",
      at: 1000,
      by: "other",
    });
    assert.equal(stale.follow?.canvas, "c2");
    assert.equal(stale.follow?.card, "release-slides");

    // Newer canvas switch replaces it and persists cleanly on read.
    saveCanvasCards({}, undefined, undefined, undefined, undefined, {
      canvas: "c3",
      at: 3000,
      by: "phone",
    });
    assert.deepEqual(readCanvasLayout().follow, { canvas: "c3", at: 3000, by: "phone" });
  } finally {
    if (prev === undefined) delete process.env.LALALA_CANVAS_FILE;
    else process.env.LALALA_CANVAS_FILE = prev;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
