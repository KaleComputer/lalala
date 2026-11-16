// Muted means no microphone: with the device bar's mute on, the mic's tracks are stopped (a disabled
// track keeps the platform's voice processing on, and iOS ducked other audio under Tim's voice,
// 15 Nov) and nothing Tim says holds or stops a reply; unmuted, he stops it again.
// Needs a running lalala dev server (its port) and Chrome; the browser is headless and muted, with
// Tim talking every 3 s on a fake mic. Phone and desktop size.
// Run: node scripts/barge-in/mute.browser.mjs 5780
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const port = process.argv[2] ?? "5780";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RATE = 24_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-mute-"));

/** Tim saying talk.wav every 3 s for a minute, over a quiet room, as the fake mic's file. */
function micFile() {
  const bytes = NodeFS.readFileSync(new URL("talk.wav", import.meta.url));
  const data = bytes.indexOf("data") + 8;
  const talk = new Int16Array((bytes.length - data) / 2).map((_, i) => bytes.readInt16LE(data + i * 2));
  const out = new Int16Array(60 * RATE);
  for (let at = 0; at + talk.length < out.length; at += 3 * RATE) out.set(talk, at);
  const wav = Buffer.alloc(44 + out.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + out.length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(out.length * 2, 40);
  Buffer.from(out.buffer).copy(wav, 44);
  const path = NodePath.join(temp, "mic.wav");
  NodeFS.writeFileSync(path, wav);
  return path;
}

async function run(device, mic) {
  const profile = NodeFS.mkdtempSync(NodePath.join(temp, "profile-"));
  const debugPort = 9300 + Math.floor(Math.random() * 600);
  // --no-sandbox lets the fake capture read its file on macOS; --mute-audio keeps the speakers silent.
  const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--mute-audio", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`, "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i += 1) {
      await sleep(200);
      try {
        target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page");
      } catch {}
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    let id = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      pending.get(message.id)?.(message);
    };
    const cdp = (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const page = async (expression) => {
      const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result?.result?.value;
    };
    if (device === "phone") {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    } else await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // Only the reply voice: no speech-to-text, so the levels and the hold alone decide.
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/?speech=voice` });
    await sleep(3_000);
    for (let i = 0; i < 90; i += 1) {
      const phase = await page(`import("/src/voice/browserSpeech/browser.ts").then((b) => b.speechStatus("voice")?.phase ?? "none")`);
      if (phase === "ready") break;
      await sleep(1_000);
    }
    await page(`import("/src/voice/speech.ts").then(async ({ VoiceSession }) => { window.__s = new VoiceSession({ onPhase() {}, onUtterance() {}, onError() {} }); await window.__s.start(); })`);
    const reply = "Here is the whole walk through of today, from the tablet speech test to the number reading, the canvas cards, the small warm voice and the names for the new model, which all come to you tonight. After that comes the plan for tomorrow, with the release notes, the new voices on the phone, the bench for the tiny model and the cards that still need a cleaner look.";
    const state = `(() => { const s = window.__s; return { live: s.stream.getAudioTracks().filter((t) => t.readyState === "live").length, holding: s.player.holding, speaking: s.player.speaking }; })()`;

    await page(`window.__s.setMuted(true)`);
    await sleep(500);
    await page(`window.__s.speak(${JSON.stringify(reply)}, true)`);
    const muted = [];
    for (let i = 0; i < 70; i += 1) muted.push(await page(state), await sleep(100));
    const mutedStates = muted.filter(Boolean);
    const failures = [];
    if (mutedStates.some((s) => s.live > 0)) failures.push("the mic stayed open while muted");
    if (!mutedStates.some((s) => s.speaking)) failures.push("the reply never played while muted");
    if (mutedStates.some((s) => s.holding)) failures.push("Tim's voice held the reply while muted");

    await page(`window.__s.setMuted(false)`);
    let stopped = false;
    let live = 0;
    for (let i = 0; i < 80 && !stopped; i += 1) {
      await sleep(100);
      const s = await page(state);
      live = Math.max(live, s.live);
      stopped = s.holding;
    }
    if (live === 0) failures.push("unmuting didn't open the mic again");
    if (!stopped) failures.push("unmuted, Tim's voice never held the reply");
    await page(`window.__s.stop()`);
    ws.close();
    return failures;
  } finally {
    chrome.kill();
    await sleep(300);
  }
}

const mic = micFile();
let failed = false;
for (const device of ["phone", "desktop"]) {
  const failures = await run(device, mic);
  console.log(failures.length === 0 ? `ok ${device}` : `FAIL ${device}: ${failures.join("; ")}`);
  failed ||= failures.length > 0;
}
NodeFS.rmSync(temp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
