// AudioContext / iOS audioSession / Bluetooth route recovery checks for callRoute.ts & speech.ts.
// Run: node --experimental-strip-types --test scripts/audio-route/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import { test } from "node:test";

import {
  callMicRate,
  matchHardwareContext,
  narrowbandCall,
  routeRebuildCheck,
  setCallMicRate,
  trackRouteInfo,
} from "../../src/voice/callRoute.ts";

function fakeContext(sampleRate, state = "running", resumeState = "running") {
  return {
    sampleRate,
    state,
    closed: false,
    async resume() {
      this.state = resumeState;
    },
    async close() {
      this.closed = true;
      this.state = "closed";
    },
  };
}

function fakeStream(label, sampleRate) {
  return {
    getAudioTracks() {
      return [
        {
          label,
          getSettings() {
            return sampleRate === undefined ? {} : { sampleRate };
          },
        },
      ];
    },
  };
}

test("trackRouteInfo takes the narrower of mic track rate and hardware AudioContext rate", () => {
  // iPhone Bluetooth HFP: track 16 kHz, stale context 44.1 kHz -> narrowband 16 kHz.
  const iosHfp = trackRouteInfo(fakeStream("BT Headset", 16_000), { sampleRate: 44_100 });
  assert.equal(iosHfp.routeRate, 16_000);
  setCallMicRate(iosHfp.routeRate);
  assert.equal(narrowbandCall(), true);

  // macOS Chrome Bluetooth HFP: track reports 48 kHz, hardware context is 16 kHz -> narrowband 16 kHz.
  const macHfp = trackRouteInfo(fakeStream("BT Headset", 48_000), { sampleRate: 16_000 });
  assert.equal(macHfp.routeRate, 16_000);
  setCallMicRate(macHfp.routeRate);
  assert.equal(narrowbandCall(), true);

  // macOS Chrome Bluetooth A2DP: track 48 kHz, hardware context 44.1 kHz -> wideband 44.1 kHz.
  const macA2dp = trackRouteInfo(fakeStream("BT Headset", 48_000), { sampleRate: 44_100 });
  assert.equal(macA2dp.routeRate, 44_100);
  setCallMicRate(macA2dp.routeRate);
  assert.equal(narrowbandCall(), false);
  assert.equal(callMicRate(), 44_100);

  // iPhone built-in mic: 48 kHz / 48 kHz -> wideband.
  const phoneMic = trackRouteInfo(fakeStream("iPhone Microphone", 48_000), { sampleRate: 48_000 });
  assert.equal(phoneMic.routeRate, 48_000);
  setCallMicRate(phoneMic.routeRate);
  assert.equal(narrowbandCall(), false);
});

test("matchHardwareContext switches from stale 44.1 kHz context to post-getUserMedia 16 kHz HFP context", async () => {
  const current = fakeContext(44_100, "running");
  const created = [];
  const next = await matchHardwareContext(current, 16_000, false, () => {
    const ctx = fakeContext(16_000, "suspended", "running");
    created.push(ctx);
    return ctx;
  });
  assert.equal(created.length, 1);
  assert.equal(next, created[0]);
  assert.equal(next.sampleRate, 16_000);
  assert.equal(next.state, "running");
  assert.equal(next.closed, false);
});

test("matchHardwareContext keeps unlocked 44.1 kHz context when hardware stays at 44.1 kHz (desktop A2DP)", async () => {
  const current = fakeContext(44_100, "running");
  const created = [];
  const next = await matchHardwareContext(current, 48_000, false, () => {
    const ctx = fakeContext(44_100, "running");
    created.push(ctx);
    return ctx;
  });
  assert.equal(created.length, 1);
  assert.equal(next, current);
  assert.equal(created[0].closed, true, "redundant probe context must be closed");
  assert.equal(current.closed, false);
});

test("matchHardwareContext falls back to running current context if replacement refuses to resume", async () => {
  const current = fakeContext(44_100, "running");
  const created = [];
  const next = await matchHardwareContext(
    current,
    16_000,
    true,
    () => {
      const ctx = fakeContext(16_000, "suspended", "suspended");
      created.push(ctx);
      return ctx;
    },
    10,
  );
  assert.equal(created.length, 1);
  assert.equal(next, current);
  assert.equal(created[0].closed, true);
});

test("matchHardwareContext rebuilds even at the same 16 kHz sampleRate when forceRebuild is true (mic.ended)", async () => {
  const current = fakeContext(16_000, "running");
  const created = [];
  const next = await matchHardwareContext(current, 16_000, true, () => {
    const ctx = fakeContext(16_000, "running");
    created.push(ctx);
    return ctx;
  });
  assert.equal(created.length, 1);
  assert.equal(next, created[0]);
  assert.equal(next.closed, false);
});

test("routeRebuildCheck triggers forceRebuild on mic.ended or device switch, and probe on rate mismatch", () => {
  // mic.ended on Bluetooth headset drop -> always force rebuild.
  assert.deepEqual(
    routeRebuildCheck({
      rebuildContext: true,
      prevLabel: "BT Headset",
      prevRate: 16_000,
      nextLabel: "BT Headset",
      nextRate: 16_000,
      contextRate: 16_000,
    }),
    { shouldCheck: true, forceRebuild: true },
  );

  // Device label changed (BT Headset -> iPhone Microphone) -> force rebuild.
  assert.deepEqual(
    routeRebuildCheck({
      rebuildContext: false,
      prevLabel: "BT Headset",
      prevRate: 16_000,
      nextLabel: "iPhone Microphone",
      nextRate: 48_000,
      contextRate: 16_000,
    }),
    { shouldCheck: true, forceRebuild: true },
  );

  // Same device and rate, matching context -> no rebuild.
  assert.deepEqual(
    routeRebuildCheck({
      rebuildContext: false,
      prevLabel: "iPhone Microphone",
      prevRate: 48_000,
      nextLabel: "iPhone Microphone",
      nextRate: 48_000,
      contextRate: 48_000,
    }),
    { shouldCheck: false, forceRebuild: false },
  );
});

test("speech.ts sets audioSession play-and-record before AudioContext in start() and updates route on reopenMic()", () => {
  const speech = NodeFS.readFileSync(new URL("../../src/voice/speech.ts", import.meta.url), "utf8");
  const startBody = speech.slice(speech.indexOf("async start(): Promise<void>"), speech.indexOf("private readonly onTouch"));
  const sessionAt = startBody.indexOf('audioSession.type = "play-and-record"');
  const contextAt = startBody.indexOf("new AudioContext()");
  assert.ok(sessionAt > 0 && contextAt > 0, "start() must set audioSession and construct AudioContext");
  assert.ok(sessionAt < contextAt, "audioSession.type = 'play-and-record' must run BEFORE new AudioContext()");
  assert.ok(startBody.includes("matchHardwareContext"), "start() must match AudioContext rate after openMic()");

  const reopenBody = speech.slice(speech.indexOf("private async reopenMic"), speech.indexOf("private openMic()"));
  assert.ok(reopenBody.includes("setActiveMicLabel("), "reopenMic() must update activeMicLabel");
  assert.ok(reopenBody.includes("setCallMicRate("), "reopenMic() must update callMicRate");
  assert.ok(reopenBody.includes("createAudioGraph("), "reopenMic() must rebuild the audio graph on route change");
  assert.ok(reopenBody.includes("label: info.label") && reopenBody.includes("settings: info.settings"), "reopenMic() must log label, rate, and settings");
});
