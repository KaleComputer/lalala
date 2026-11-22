// First-run onboarding & Starter Selector logic + synced settings persistence.
// Run: node --experimental-strip-types --test scripts/starter/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_STARTER_IDS,
  STARTER_BAR_ROOM,
  STARTER_CARD_ID,
  STARTER_PRESETS,
  closeStarterState,
  isOnboardingDismissed,
  isStarterForcedOpen,
  openStarterState,
  presetsToSpawn,
  setOnboardingDismissedFromExtras,
  shouldShowStarter,
  starterAt,
  starterCardHtml,
  subscribeStarter,
  toggleStarterSelection,
} from "../../src/voice/extras/starterLogic.ts";
import {
  onboardingDismissed,
  parseSynced,
  setOnboardingDismissed,
} from "../../src/voice/settingsStore.ts";

function installMemoryStorage() {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  return {
    store,
    restore() {
      globalThis.localStorage = prev;
    },
  };
}

test("shouldShowStarter auto-mounts only on fresh empty Main in the local app, and always when re-opened", () => {
  const base = {
    enabled: true,
    layoutReady: true,
    activeCanvas: "main",
    userCardCount: 0,
    dismissed: false,
    forcedOpen: false,
  };

  assert.equal(shouldShowStarter(base), true);
  assert.equal(shouldShowStarter({ ...base, layoutReady: false }), false);
  assert.equal(shouldShowStarter({ ...base, activeCanvas: "" }), false);
  assert.equal(shouldShowStarter({ ...base, activeCanvas: "c2" }), false);
  assert.equal(shouldShowStarter({ ...base, userCardCount: 1 }), false);
  assert.equal(shouldShowStarter({ ...base, dismissed: true }), false);
  assert.equal(shouldShowStarter({ ...base, enabled: false }), false);

  // Explicit re-open from CanvasSwitcher works even when Main has cards, onboarding was dismissed,
  // or the user is on a secondary canvas or lalala.talk.
  assert.equal(shouldShowStarter({ ...base, userCardCount: 4, dismissed: true, forcedOpen: true }), true);
  assert.equal(shouldShowStarter({ ...base, activeCanvas: "c2", dismissed: true, forcedOpen: true }), true);
  assert.equal(shouldShowStarter({ ...base, enabled: false, forcedOpen: true }), true);
  assert.equal(shouldShowStarter({ ...base, layoutReady: false, forcedOpen: true }), false);
});

test("starterAt centres the card above the device bar across desktop, laptop, phone, and short screens", () => {
  for (const [w, h] of [
    [1440, 900],
    [1280, 720],
    [390, 844],
    [800, 500],
  ]) {
    const rect = starterAt(w, h);
    assert.ok(rect.x >= 12, `x >= 12 on ${w}x${h}`);
    assert.ok(rect.y >= 48, `y >= 48 on ${w}x${h}`);
    assert.ok(rect.x + rect.w <= w - 12 + 1, `fits width on ${w}x${h}`);
    assert.ok(rect.w >= 280 && rect.w <= 520, `width bounded on ${w}x${h}`);
    assert.ok(rect.h >= 260 && rect.h <= 440, `height bounded on ${w}x${h}`);
    if (h >= 680) {
      assert.ok(rect.y + rect.h <= h - STARTER_BAR_ROOM + 24, `clears bar on ${w}x${h}`);
    }
  }
});

test("preset selection toggles cleanly and skips already-mounted cards without clobbering", () => {
  assert.equal(STARTER_CARD_ID, "starter");
  assert.deepEqual(
    STARTER_PRESETS.map((preset) => preset.id),
    ["today-todo", "agent-monitor", "quick-chat", "image-gen", "video-gen"],
  );
  assert.deepEqual(DEFAULT_STARTER_IDS, ["today-todo", "agent-monitor"]);

  const added = toggleStarterSelection(DEFAULT_STARTER_IDS, "image-gen");
  assert.deepEqual(added, ["today-todo", "agent-monitor", "image-gen"]);
  const removed = toggleStarterSelection(added, "today-todo");
  assert.deepEqual(removed, ["agent-monitor", "image-gen"]);

  const toSpawn = presetsToSpawn(added, new Set(["today-todo"]));
  assert.deepEqual(
    toSpawn.map((preset) => preset.id),
    ["agent-monitor", "image-gen"],
  );
});

test("starterCardHtml renders self-contained monochrome cards with no external URLs", () => {
  for (const preset of STARTER_PRESETS) {
    const html = starterCardHtml(preset);
    assert.ok(html.includes("<style>"), `${preset.id} has inline styles`);
    assert.ok(!/https?:\/\//i.test(html), `${preset.id} has no external URLs`);
    assert.ok(html.length > 200, `${preset.id} has meaningful content`);
  }
});

test("openStarterState / closeStarterState notify subscribers cleanly", () => {
  let events = 0;
  const stop = subscribeStarter(() => {
    events += 1;
  });
  try {
    closeStarterState();
    assert.equal(isStarterForcedOpen(), false);
    openStarterState();
    assert.equal(isStarterForcedOpen(), true);
    const afterOpen = events;
    openStarterState();
    assert.equal(events, afterOpen, "duplicate open does not re-emit");
    closeStarterState();
    assert.equal(isStarterForcedOpen(), false);
    assert.equal(events, afterOpen + 1);
  } finally {
    stop();
  }
});

test("settingsStore persists onboardingDismissed in synced settings and bridges to extras", async () => {
  const parsedDefault = parseSynced({});
  assert.equal(parsedDefault?.onboardingDismissed, false);
  assert.equal(parseSynced({ onboardingDismissed: true })?.onboardingDismissed, true);
  assert.equal(parseSynced({ onboardingDismissed: "yes" })?.onboardingDismissed, false);

  const mem = installMemoryStorage();
  const writes = [];
  const prevAdapters = globalThis.__lalalaAdapters;
  globalThis.__lalalaAdapters = {
    storage: {
      shared: true,
      read: async () => null,
      write: async (doc, body) => {
        writes.push({ doc, body });
        return body;
      },
    },
  };
  try {
    setOnboardingDismissed(false);
    assert.equal(onboardingDismissed(), false);
    assert.equal(isOnboardingDismissed(), false);

    setOnboardingDismissedFromExtras(true);
    assert.equal(onboardingDismissed(), true);
    assert.equal(isOnboardingDismissed(), true);

    const stored = JSON.parse(mem.store.get("lalala:settings") ?? "null");
    assert.equal(stored?.onboardingDismissed, true);
    assert.equal(writes.at(-1)?.doc, "settings");
    assert.equal(writes.at(-1)?.body?.onboardingDismissed, true);
  } finally {
    setOnboardingDismissed(false);
    globalThis.__lalalaAdapters = prevAdapters;
    mem.restore();
  }
});
