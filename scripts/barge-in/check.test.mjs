// Barge-in on recorded speech: Tim talking close or saying "stop" over a playing reply silences it
// within 300 ms; background noise and the reply's own echo never do. With and without the voice
// detector, since a phone that can't load it (15 Nov, out of memory) must still stop for him.
// The recordings are Kokoro (af_heart, Apache-2.0) from scripts/speech: reply.wav is the reply that
// plays, talk.wav and stop.wav are Tim close to the mic. The room, the echo path and the noise are
// mixed here, frame by frame, the way speech.ts feeds the gate and bargeIn.ts.
// Run: node --experimental-strip-types --test scripts/barge-in/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import { test } from "node:test";

import { createBargeHold, voiceOverHold } from "../../src/voice/bargeIn.ts";
import { createCloseTalk } from "../../src/voice/presence/closetalk.js";
import { heldReply } from "../../src/voice/topicHold.ts";

const RATE = 24_000;
const FRAME_MS = 20;
const FRAME = (RATE * FRAME_MS) / 1000;
const ECHO_TAIL_MS = 600;
const HOLD_RELEASE_MS = 700;
const HOLD_MAX_MS = 2_000;

function readWav(name) {
  const bytes = NodeFS.readFileSync(new URL(name, import.meta.url));
  const data = bytes.indexOf("data") + 8;
  const out = new Float32Array((bytes.length - data) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readInt16LE(data + i * 2) / 0x8000;
  return out;
}
const reply = readWav("reply.wav");
const talk = readWav("talk.wav");
const stop = readWav("stop.wav");

const db = (x) => 20 * Math.log10(x + 1e-9);
const rms = (s, at) => {
  let e = 0;
  for (let i = at; i < at + FRAME; i += 1) e += (s[i] ?? 0) ** 2;
  return Math.sqrt(e / FRAME);
};
/** The 20 ms frames' mean level where the sound is (dBFS), to place a recording at a level. */
function speechDb(s) {
  const levels = [];
  for (let at = 0; at + FRAME <= s.length; at += FRAME) levels.push(rms(s, at));
  const loud = levels.filter((l) => db(l) > db(Math.max(...levels)) - 25);
  return db(Math.sqrt(loud.reduce((a, l) => a + l * l, 0) / loud.length));
}
const scaled = (s, toDb) => {
  const gain = 10 ** ((toDb - speechDb(s)) / 20);
  return s.map((x) => x * gain);
};
/** A seeded noise source, so every run hears the same room. */
function random(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
}
/** Pink-ish room noise (traffic, a fan) at `levelDb` RMS. */
function roomNoise(length, levelDb, seed = 7) {
  const next = random(seed);
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i += 1) {
    const w = next();
    b0 = 0.997 * b0 + 0.029 * w;
    b1 = 0.985 * b1 + 0.032 * w;
    b2 = 0.95 * b2 + 0.048 * w;
    out[i] = b0 + b1 + b2 + 0.02 * w;
  }
  const now = db(Math.sqrt(out.reduce((a, x) => a + x * x, 0) / length));
  return out.map((x) => x * 10 ** ((levelDb - now) / 20));
}
const lowpass = (s, hz) => {
  const a = Math.exp((-2 * Math.PI * hz) / RATE);
  let y = 0;
  return s.map((x) => (y = (1 - a) * x + a * y));
};
function addAt(into, sound, atMs, gain = 1) {
  const at = Math.round((atMs / 1000) * RATE);
  for (let i = 0; i < sound.length && at + i < into.length; i += 1) into[at + i] += sound[i] * gain;
}

/**
 * One call on a phone (sensitivity 0) or a desktop (1): a quiet room, Tim's first turn (the gate
 * learns his voice), then the reply plays from REPLY_AT. `sounds` go on the mic, Tim's at `timAt`.
 * Returns when the reply went on hold and what the held reply's verdict was.
 */
function call({ sensitivity = 0, vad, echoDb = -25, noiseDb = -58, sounds = [], timAt = null }) {
  const REPLY_AT = 6_000;
  const length = Math.round(((REPLY_AT + 12_000) / 1000) * RATE);
  const played = new Float32Array(length);
  addAt(played, reply, REPLY_AT);
  const timTrack = new Float32Array(length);
  addAt(timTrack, scaled(talk, -18), 2_000); // his first turn, before the reply
  const others = new Float32Array(length);
  for (const { sound, atMs, gain = 1, tim = false } of sounds) addAt(tim ? timTrack : others, sound, atMs, gain);
  const room = roomNoise(length, noiseDb);
  const echoGain = 10 ** (echoDb / 20);
  const echoDelay = Math.round(0.05 * RATE);
  const echoOf = lowpass(played, 3_500);

  const gate = createCloseTalk({ sensitivity });
  const barge = createBargeHold();
  let heldAt = null;
  let heldVoiceAt = 0;
  let verdict = null;
  let vadRun = 0;
  const replyEndsAt = REPLY_AT + (reply.length / RATE) * 1000;
  for (let at = 0, t = 0; at + FRAME <= length; at += FRAME, t += FRAME_MS) {
    const holding = heldAt !== null && verdict === null;
    // On hold the reply goes silent at once, and so does its echo.
    const mic = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) {
      const echo = holding ? 0 : (echoOf[at + i - echoDelay] ?? 0) * echoGain;
      mic[i] = timTrack[at + i] + others[at + i] + room[at + i] + echo;
    }
    micFrames.push(mic);
    const level = rms(windCutFrames(), 0);
    const replyDb = holding ? -180 : db(rms(played, at));
    const playing = t >= REPLY_AT && t < replyEndsAt && verdict !== "stop";
    const replyAudible = t >= REPLY_AT && t < replyEndsAt + ECHO_TAIL_MS && verdict !== "stop";
    const decision = gate.step(db(level), replyAudible ? "speak" : "listen", FRAME_MS);
    // The voice detector hears speech, any speech: Tim, people further off and our echo alike.
    const speechNow = db(rms(timTrack, at)) > -50 || db(rms(others, at)) > -50 || (!holding && db(rms(echoOf, at - echoDelay) * echoGain) > -50);
    vadRun = speechNow ? vadRun + FRAME_MS : 0;
    const vadState = { ready: vad, voiceMs: vad ? vadRun : 0, voiceNow: vad && speechNow };
    const close = gate.voiced || gate.open;
    const hold = barge.step({
      frameMs: FRAME_MS,
      micDb: db(level),
      replyDb,
      close,
      openedOverReply: decision.opened && decision.by === "speak",
      voiceLike: true,
      floorDb: decision.floor,
      vad: vadState,
      canHold: playing && heldAt === null,
    });
    if (hold !== null && heldAt === null && playing) {
      heldAt = t;
      heldVoiceAt = t;
      if (process.env.BARGE_DEBUG) console.log("hold", hold, t, Math.round(db(level)), Math.round(barge.replyDb), Math.round(decision.floor), Math.round(decision.bar));
    }
    if (holding) {
      if (voiceOverHold({ close, voiceLike: true, vad: vadState })) heldVoiceAt = t;
      const v = heldReply(t, heldAt, heldVoiceAt, HOLD_RELEASE_MS, HOLD_MAX_MS);
      if (v !== "wait") verdict = v;
    }
  }
  micFrames.length = 0;
  windState.y = windState.prev = 0;
  return { heldAfterMs: heldAt === null || timAt === null ? heldAt : heldAt - timAt, heldAt, verdict };
}
// The wind cut runs across frames, as the worklet's filter does.
const micFrames = [];
const windState = { y: 0, prev: 0 };
const WIND_A = Math.exp((-2 * Math.PI * 180) / RATE);
function windCutFrames() {
  const frame = micFrames[micFrames.length - 1];
  const out = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) {
    windState.y = WIND_A * (windState.y + frame[i] - windState.prev);
    windState.prev = frame[i];
    out[i] = windState.y;
  }
  return out;
}

const DEVICES = [
  { name: "phone", sensitivity: 0 },
  { name: "desktop", sensitivity: 1 },
];
const TIM_AT = 8_500; // 2.5 s into the reply
const onset = (sound) => {
  for (let at = 0; at + FRAME <= sound.length; at += FRAME) if (db(rms(sound, at)) > -45) return (at / RATE) * 1000;
  return 0;
};

for (const device of DEVICES) {
  for (const vad of [false, true]) {
    const label = `${device.name}, voice detector ${vad ? "on" : "off"}`;

    test(`${label}: Tim talking close over the reply silences it within 300 ms, and keeps it stopped`, () => {
      const sound = scaled(talk, -18);
      const r = call({ ...device, vad, sounds: [{ sound, atMs: TIM_AT, tim: true }], timAt: TIM_AT + onset(sound) });
      assert.ok(r.heldAt !== null, "the reply never went on hold");
      assert.ok(r.heldAfterMs <= 300, `held ${r.heldAfterMs} ms after he started`);
      assert.equal(r.verdict, "stop");
    });

    test(`${label}: Tim at a normal speaking level silences it within 300 ms`, () => {
      const sound = scaled(talk, -23);
      const r = call({ ...device, vad, sounds: [{ sound, atMs: TIM_AT, tim: true }], timAt: TIM_AT + onset(sound) });
      assert.ok(r.heldAt !== null, "the reply never went on hold");
      assert.ok(r.heldAfterMs <= 300, `held ${r.heldAfterMs} ms after he started`);
    });

    test(`${label}: "stop" silences it within 300 ms`, () => {
      const sound = scaled(stop, -18);
      const r = call({ ...device, vad, sounds: [{ sound, atMs: TIM_AT, tim: true }], timAt: TIM_AT + onset(sound) });
      assert.ok(r.heldAt !== null, "the reply never went on hold");
      assert.ok(r.heldAfterMs <= 300, `held ${r.heldAfterMs} ms after he started`);
    });

    test(`${label}: the reply's own echo, even loud, never holds it`, () => {
      const r = call({ ...device, vad, echoDb: -15 });
      assert.equal(r.heldAt, null, `held at ${r.heldAt} ms`);
    });

    test(`${label}: someone talking across the room in a quiet room never holds it`, () => {
      // A browser's noise suppression leaves the room near -65 dB; a voice 3-4 m off reaches ~-42.
      const other = lowpass(scaled(talk, -42), 3_000);
      const r = call({
        ...device,
        vad,
        noiseDb: -66,
        sounds: [7_000, 9_900, 12_800].map((atMs) => ({ sound: other, atMs })),
      });
      assert.equal(r.heldAt, null, `held at ${r.heldAt} ms`);
    });

    test(`${label}: a loud room (traffic, people talking further off, a door) never holds it`, () => {
      const chatter = lowpass(scaled(talk, -38), 2_500);
      const door = roomNoise(Math.round(0.06 * RATE), -8, 3).map((x, i) => x * Math.exp(-i / (0.015 * RATE)));
      const r = call({
        ...device,
        vad,
        noiseDb: -44,
        sounds: [
          { sound: chatter, atMs: 7_000 },
          { sound: chatter, atMs: 9_800 },
          { sound: door, atMs: 9_000 },
          { sound: door, atMs: 11_000 },
        ],
      });
      assert.equal(r.heldAt, null, `held at ${r.heldAt} ms`);
    });
  }
}
