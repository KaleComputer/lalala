// Card and data edits during a call apply in place and never light the bar's update chip; only
// lalala's own code waits for the call to end, and no HMR reload path may ever auto-reload while a
// call is active (connecting, listening, thinking, speaking, or loading speech models).
// Run: node --experimental-strip-types --test scripts/live-update/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appliesLive,
  handleHmrFullReload,
  installHmrCallGuard,
  reloadsPage,
} from "../../src/voice/liveUpdate.ts";

const CARDS = "/@fs/srv/brain/cards/";

function makeFakeHot(options = {}) {
  const listeners = new Map();
  const hmrClient = options.importUpdatedModule
    ? { importUpdatedModule: options.importUpdatedModule }
    : undefined;
  return {
    hot: {
      on(event, cb) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      },
      hmrClient,
    },
    async emit(event, payload) {
      const list = listeners.get(event) ?? [];
      return Promise.all(list.map((cb) => cb(payload)));
    },
  };
}

function makeFakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setIntervalFn(cb) {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearIntervalFn(id) {
      timers.delete(id);
    },
    tick() {
      for (const cb of [...timers.values()]) cb();
    },
    get activeCount() {
      return timers.size;
    },
  };
}

test("the user's cards and their data apply live", () => {
  for (const path of [
    `${CARDS}NeedsTim.tsx`,
    `${CARDS}needsTimItems.ts?t=1763550000000`,
    `${CARDS}needsTim.json?import&t=1`,
    `${CARDS}index.tsx`,
  ]) {
    assert.equal(appliesLive(path, CARDS), true, path);
  }
});

test("extras and CSS apply live", () => {
  assert.equal(appliesLive("/src/voice/extras/CanvasCard.tsx", CARDS), true);
  assert.equal(appliesLive("/src/voice/voiceBar.css?t=2", CARDS), true);
});

test("lalala's own code is an app update", () => {
  for (const path of ["/src/voice/VoiceBar.tsx", "/src/voice/speechText.ts?t=3", "/src/app/main.tsx"]) {
    assert.equal(appliesLive(path, CARDS), false, path);
  }
  assert.equal(appliesLive(`${CARDS}NeedsTim.tsx`, undefined), false);
});

test("reloadsPage matches only this page or non-html reloads", () => {
  assert.equal(reloadsPage(undefined, "/"), true);
  assert.equal(reloadsPage("*", "/"), true);
  assert.equal(reloadsPage("/index.html", "/"), true);
  assert.equal(reloadsPage("/index.html", "/canvas"), true);
  assert.equal(reloadsPage("/canvas/index.html", "/canvas/"), true);
  assert.equal(reloadsPage("/canvasindex.html", "/canvas"), false);
  assert.equal(reloadsPage("/cards/clock.html", "/"), false);
});

test("core updates and full reloads during an active call defer to the chip and reload only after hangup", async () => {
  for (const activeState of ["connecting", "listening", "thinking", "speaking"]) {
    let callState = activeState;
    const held = [];
    const reloads = [];
    let overlaysCleared = 0;
    const clock = makeFakeClock();
    const { hot, emit } = makeFakeHot();

    installHmrCallGuard({
      hot,
      callActive: () => callState !== "off",
      voiceIdle: () => callState === "off",
      cardsUrl: () => CARDS,
      pathname: () => "/",
      onHold: (what) => held.push(what),
      onReload: (why) => reloads.push(why),
      clearErrorOverlays: () => {
        overlaysCleared += 1;
      },
      keepAcrossDisconnects: () => true,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });

    // Core app update mixed with a live card update: card passes, core is stripped and held.
    const updatePayload = {
      updates: [
        { path: `${CARDS}NeedsTim.tsx` },
        { path: "/src/voice/VoiceHost.tsx" },
      ],
    };
    await emit("vite:beforeUpdate", updatePayload);
    assert.deepEqual(updatePayload.updates, [{ path: `${CARDS}NeedsTim.tsx` }]);
    assert.equal(overlaysCleared, 1, activeState);
    assert.deepEqual(held, ["/src/voice/VoiceHost.tsx"], activeState);
    assert.deepEqual(reloads, [], activeState);

    // Full reload while still active: rewritten to inert path, never reloads.
    const fullReload = { path: "*" };
    await emit("vite:beforeFullReload", fullReload);
    assert.equal(fullReload.path, "/__lalala-held.html", activeState);
    assert.deepEqual(reloads, [], activeState);

    // Polling ticks while still in the call must not reload.
    clock.tick();
    await Promise.resolve();
    assert.deepEqual(reloads, [], activeState);

    // Hanging up allows the deferred reload to run once.
    callState = "off";
    clock.tick();
    await Promise.resolve();
    assert.deepEqual(reloads, ["held dev update, voice off"], activeState);
  }
});

test("live card update during a call clears Vite error overlays so Vite never auto-reloads on first update", async () => {
  const held = [];
  let overlaysCleared = 0;
  const { hot, emit } = makeFakeHot();

  installHmrCallGuard({
    hot,
    callActive: () => true,
    voiceIdle: () => false,
    cardsUrl: () => CARDS,
    pathname: () => "/",
    onHold: (what) => held.push(what),
    onReload: () => {
      throw new Error("must not reload");
    },
    clearErrorOverlays: () => {
      overlaysCleared += 1;
    },
    keepAcrossDisconnects: () => true,
  });

  const payload = { updates: [{ path: `${CARDS}NeedsTim.tsx` }] };
  await emit("vite:beforeUpdate", payload);
  assert.equal(overlaysCleared, 1);
  assert.deepEqual(held, []);
  assert.deepEqual(payload.updates, [{ path: `${CARDS}NeedsTim.tsx` }]);
});

test("circular-import HMR failure during a call never triggers Vite's circular pageReload", async () => {
  const seenArgs = [];
  const held = [];
  const { hot } = makeFakeHot({
    async importUpdatedModule(arg) {
      seenArgs.push(arg);
      throw new Error("circular failure");
    },
  });

  installHmrCallGuard({
    hot,
    callActive: () => true,
    voiceIdle: () => false,
    cardsUrl: () => CARDS,
    pathname: () => "/",
    onHold: (what) => held.push(what),
    onReload: () => {
      throw new Error("must not reload");
    },
    clearErrorOverlays: () => {},
    keepAcrossDisconnects: () => true,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  await assert.rejects(
    () =>
      hot.hmrClient.importUpdatedModule({
        acceptedPath: "/src/voice/extras/Card.tsx",
        timestamp: 123,
        isWithinCircularImport: true,
      }),
    /circular failure/,
  );
  assert.equal(seenArgs[0].isWithinCircularImport, false);
  assert.deepEqual(held, ["/src/voice/extras/Card.tsx"]);
});

test("ws disconnect fallback never reloads if a call is active or starts while server is down", async () => {
  let active = false;
  const held = [];
  const reloads = [];
  let serverBack;
  const clock = makeFakeClock();
  const { hot, emit } = makeFakeHot();

  installHmrCallGuard({
    hot,
    callActive: () => active,
    voiceIdle: () => !active,
    cardsUrl: () => CARDS,
    pathname: () => "/",
    onHold: (what) => held.push(what),
    onReload: (why) => reloads.push(why),
    clearErrorOverlays: () => {},
    keepAcrossDisconnects: () => false,
    waitForServer: () => new Promise((resolve) => (serverBack = resolve)),
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });

  // Disconnect happens while idle, then the user starts a call before the server responds.
  let settled = false;
  const disconnectDone = emit("vite:ws:disconnect", { webSocket: { url: "ws://127.0.0.1:5780" } }).then(() => {
    settled = true;
  });
  active = true;
  serverBack();
  await Promise.resolve();
  await Promise.resolve();

  // Vite's own disconnect reload stays blocked and the update is held until hangup.
  assert.equal(settled, false);
  assert.deepEqual(held, ["server reconnect"]);
  assert.deepEqual(reloads, []);

  // Once the call ends, the held reload proceeds cleanly.
  active = false;
  clock.tick();
  await Promise.resolve();
  assert.deepEqual(reloads, ["held dev update, voice off"]);
  void disconnectDone;
});

test("reconnected HMR full-reload never reloads during an active call even without payload mutation", () => {
  const held = [];
  const reloads = [];

  assert.equal(
    handleHmrFullReload({
      path: undefined,
      pathname: "/",
      callActive: () => true,
      hold: (what) => held.push(what),
      reload: () => reloads.push("reloaded"),
    }),
    false,
  );
  assert.deepEqual(held, ["full reload"]);
  assert.deepEqual(reloads, []);

  // Unrelated card html never reloads even when idle.
  assert.equal(
    handleHmrFullReload({
      path: "/cards/clock.html",
      pathname: "/",
      callActive: () => false,
      hold: (what) => held.push(what),
      reload: () => reloads.push("reloaded"),
    }),
    false,
  );
  assert.deepEqual(reloads, []);

  // Page full-reload proceeds when idle.
  assert.equal(
    handleHmrFullReload({
      path: "/index.html",
      pathname: "/",
      callActive: () => false,
      hold: (what) => held.push(what),
      reload: () => reloads.push("reloaded"),
    }),
    true,
  );
  assert.deepEqual(reloads, ["reloaded"]);
});
