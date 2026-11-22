// Settle action (harness + HTTP fallback) and Follow helpers (tags + HMR path matching).
// Run: node --experimental-strip-types --test scripts/settle-follow/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import {
  followCommand,
  isFollowing,
  isFollowLabEnabled,
  matchCardByModulePath,
  setFollowing,
  subscribeFollow,
  takeAboutCards,
  takeFocus,
} from "../../src/voice/follow.ts";
import { applyInboxChange, captureInbox, EMPTY_INBOX } from "../../src/voice/inbox/capture.ts";
import { parseSynced } from "../../src/voice/settingsStore.ts";
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

test("labs.followButton defaults off and parses strictly as boolean", () => {
  assert.equal(parseSynced({})?.labs.followButton, false);
  assert.equal(parseSynced({ labs: { followButton: true } })?.labs.followButton, true);
  assert.equal(parseSynced({ labs: { followButton: "yes" } })?.labs.followButton, false);
});

function withMockLocalStorage(fn) {
  const store = new Map();
  const prevStorage = globalThis.localStorage;
  const mock = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
  try {
    return fn(store);
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else {
      Object.defineProperty(globalThis, "localStorage", {
        value: prevStorage,
        configurable: true,
        writable: true,
      });
    }
  }
}

test("effective Follow is always off when labs.followButton is false, even if lalala:follow is stored as 1", () => {
  withMockLocalStorage((store) => {
    setFollowing(true);
    assert.equal(store.get("lalala:follow"), "1");
    assert.equal(isFollowLabEnabled(), false);
    assert.equal(isFollowing(), false);

    store.set("lalala:settings", JSON.stringify({ labs: { followButton: false } }));
    assert.equal(isFollowLabEnabled(), false);
    assert.equal(isFollowing(), false);

    store.set("lalala:settings", JSON.stringify({ labs: { followButton: true } }));
    assert.equal(isFollowLabEnabled(), true);
    assert.equal(isFollowing(), true);

    setFollowing(false);
    assert.equal(isFollowing(), false);
  });
});

test("subscribeFollow reacts to both lalala:follow and lalala:settings updates", () => {
  const docListeners = new Map();
  const winListeners = new Map();
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  Object.defineProperty(globalThis, "document", {
    value: {
      addEventListener: (type, fn) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
      removeEventListener: (type, fn) =>
        docListeners.set(
          type,
          (docListeners.get(type) ?? []).filter((f) => f !== fn),
        ),
      dispatchEvent: (event) => {
        for (const fn of docListeners.get(event.type) ?? []) fn(event);
        return true;
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: (type, fn) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
      removeEventListener: (type, fn) =>
        winListeners.set(
          type,
          (winListeners.get(type) ?? []).filter((f) => f !== fn),
        ),
    },
    configurable: true,
    writable: true,
  });
  try {
    let calls = 0;
    const stop = subscribeFollow(() => {
      calls += 1;
    });
    globalThis.document.dispatchEvent(new Event("lalala:follow"));
    globalThis.document.dispatchEvent(new Event("lalala:settings"));
    for (const fn of winListeners.get("storage") ?? []) fn({ key: "lalala:settings" });
    for (const fn of winListeners.get("storage") ?? []) fn({ key: "unrelated" });
    assert.equal(calls, 3);
    stop();
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { value: prevDoc, configurable: true, writable: true });
    if (prevWin === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { value: prevWin, configurable: true, writable: true });
  }
});

test("followCommand only matches explicit commands and never turns Follow on for negative or casual phrases", () => {
  assert.equal(followCommand("follow"), true);
  assert.equal(followCommand("follow me"), true);
  assert.equal(followCommand("turn follow on"), true);
  assert.equal(followCommand("stop following"), false);
  assert.equal(followCommand("unfollow"), false);
  assert.equal(followCommand("turn off follow"), false);
  assert.equal(followCommand("turn follow off"), false);
  assert.equal(followCommand("follow up on that"), undefined);
  assert.equal(followCommand("is follow on?"), undefined);
  assert.equal(followCommand("can you follow?"), undefined);
});

test("viewport jump guards stay intact across canvasStore, CanvasSurface, BrainCards, VoiceHost, and VoiceSettings", () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const storeSrc = NodeFS.readFileSync(NodePath.join(root, "src/voice/extras/canvasStore.ts"), "utf8");
  const surfaceSrc = NodeFS.readFileSync(NodePath.join(root, "src/voice/extras/CanvasSurface.tsx"), "utf8");
  const brainCardsSrc = NodeFS.readFileSync(NodePath.join(root, "src/voice/extras/BrainCards.tsx"), "utf8");
  const hostSrc = NodeFS.readFileSync(NodePath.join(root, "src/voice/VoiceHost.tsx"), "utf8");
  const settingsSrc = NodeFS.readFileSync(NodePath.join(root, "src/voice/VoiceSettings.tsx"), "utf8");

  // canvasStore gates Follow on labs.followButton and excludes built-in chrome cards (agent-monitor, starter).
  assert.match(storeSrc, /raw\?\.labs\?\.followButton === true/);
  assert.match(storeSrc, /NO_AUTO_FOLLOW\s*=\s*new Set\(\[STARTER_CARD_ID,\s*"agent-monitor"\]\)/);

  // fitCard must never call followCard (prevents AgentMonitor row growth / lazy card mount jump loops).
  const fitBody = storeSrc.slice(storeSrc.indexOf("export function fitCard("), storeSrc.indexOf("function roomToGrow("));
  assert.doesNotMatch(fitBody, /followCard\(/);

  // touchCard must never emit cross-device follow signals.
  const touchBody = storeSrc.slice(storeSrc.indexOf("export function touchCard("), storeSrc.indexOf("function changed("));
  assert.doesNotMatch(touchBody, /emitFollowSignal\(/);

  // mountCard must not auto-follow pre-existing cards with saved boxes.
  const mountBody = storeSrc.slice(storeSrc.indexOf("export function mountCard("), storeSrc.indexOf("export function setView("));
  assert.doesNotMatch(mountBody, /followCard\(/);

  // focusCard must default broadcast to false so local focus never hijacks another device.
  assert.match(storeSrc, /function focusCard\(name: string, broadcast = false\)/);

  // emitFollowSignal must require isFollowOn().
  const emitBody = storeSrc.slice(storeSrc.indexOf("function emitFollowSignal("), storeSrc.indexOf("function adoptFollowSignal("));
  assert.match(emitBody, /!isFollowOn\(\)/);

  // CanvasSurface DOM fallback only fires on unmatched card HMR and disarms after matching.
  assert.match(surfaceSrc, /lastUnmatchedCardHmrAt/);

  // BrainCards delegates follow to followCard instead of raw localStorage.getItem("lalala:follow").
  assert.doesNotMatch(brainCardsSrc, /localStorage\.getItem\("lalala:follow"\)/);
  assert.match(brainCardsSrc, /followCard\(id,\s*"brain-card"\)/);

  // VoiceHost never broadcasts focus across devices and gates voice "follow" command on Labs.
  assert.match(hostSrc, /focus\?\.\(card,\s*false\)/);
  assert.match(hostSrc, /isFollowLabEnabled\(\)/);

  // Settings disables Follow canvas toggle while Labs -> Follow button is off.
  assert.match(settingsSrc, /disabled=\{!followLab\}/);
});
