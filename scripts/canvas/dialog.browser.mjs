// A card's full-screen dialog (a picture's zoom) must not outlive the view moving away from its card.
// A card not drawn hides its content (content-visibility), and a modal <dialog> inside stays modal
// but unseen: the page took no clicks, so the mini-map and zoom looked dead (16 Nov, after a new
// card was focused while a diagram's zoom was open). Opens the dialog by mouse (desktop size) and by
// touch (phone size), focuses another card, then expects the dialog closed and the map to move the view.
// Starts its own lalala (temp cards and state, its own port) and a headless, muted Chrome.
// Run: node scripts/canvas/dialog.browser.mjs
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = NodePath.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Real path: macOS's temp folder is a symlink, and Vite serves the cards by their real path.
const temp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-dialog-")));
const cards = NodePath.join(temp, "cards");
NodeFS.mkdirSync(cards);
NodeFS.writeFileSync(
  NodePath.join(cards, "Zoom.tsx"),
  `import { useRef } from "react";
export function Zoom() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" data-test-open="" style={{ width: 200, height: 120 }} onClick={() => dialog.current?.showModal()}>open</button>
      <dialog ref={dialog} data-test-zoom="" style={{ width: "100vw", height: "100vh", maxWidth: "100vw", maxHeight: "100vh", margin: 0 }}>zoom</dialog>
    </>
  );
}
`,
);
NodeFS.writeFileSync(
  NodePath.join(cards, "index.tsx"),
  `import { CanvasCard } from "./CanvasCard";
import { Zoom } from "./Zoom";
export default function Cards() {
  return (
    <>
      <CanvasCard id="zoom" title="Zoom" at={{ x: 12, y: 12, w: 480, h: 360 }}><Zoom /></CanvasCard>
      <CanvasCard id="other" title="Other" at={{ x: 12, y: 400, w: 400, h: 300 }}><p>other</p></CanvasCard>
    </>
  );
}
`,
);

const port = 5800 + Math.floor(Math.random() * 190);
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, LALALA_PORT: String(port), LALALA_CARDS_DIR: cards, LALALA_STATE_DIR: NodePath.join(temp, "state") },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (chunk) => String(chunk).includes("lalala on") && resolve());
  server.on("exit", () => reject(new Error("lalala didn't start")));
});

async function run(device) {
  const profile = NodeFS.mkdtempSync(NodePath.join(temp, "profile-"));
  const debugPort = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(CHROME, ["--headless=new", "--mute-audio", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
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
    const until = async (expression, what) => {
      for (let i = 0; i < 150; i += 1) {
        if (await page(expression)) return;
        await sleep(200);
      }
      throw new Error(`${device}: ${what} never came`);
    };
    const center = (selector) =>
      page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const press = async ({ x, y }) => {
      if (device === "phone") {
        await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      }
    };
    if (device === "phone") {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    } else await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await until(`!!document.querySelector("[data-test-open]") && !!document.querySelector("[data-lalala-map] > canvas")`, "the card");
    const store = `import("/src/voice/extras/canvasStore.ts")`;
    // The other card far away, so focusing it leaves the zoom's card undrawn.
    await page(`${store}.then((s) => { s.setCard("other", { x: 9000, y: 9000, w: 400, h: 300 }); s.lookAt(252, 192); })`);
    await sleep(500);
    await press(await center("[data-test-open]"));
    await until(`document.querySelector("[data-test-zoom]").open`, "the open dialog");

    const failures = [];
    await page(`globalThis.__lalalaCanvases.focus("other")`);
    await sleep(1_000);
    const zoom = await page(`(() => { const d = document.querySelector("[data-test-zoom]"); return { open: d.open, seen: d.checkVisibility() }; })()`);
    if (zoom.open && !zoom.seen) failures.push(`${device}: the dialog stayed open, unseen, over a dead page`);
    else if (zoom.open) failures.push(`${device}: the dialog stayed open over the focused card`);

    const camera = `${store}.then((s) => JSON.stringify(s.getCamera()))`;
    const before = await page(camera);
    const map = await page(`(() => { const r = document.querySelector("[data-lalala-map] > canvas").getBoundingClientRect(); return { x: r.x + r.width * 0.15, y: r.y + r.height * 0.15 }; })()`);
    await press(map);
    await sleep(300);
    if ((await page(camera)) === before) failures.push(`${device}: a press on the mini-map didn't move the view`);
    ws.close();
    return failures;
  } finally {
    chrome.kill();
    await sleep(300);
  }
}

let failures = [];
try {
  failures = [...(await run("desktop")), ...(await run("phone"))];
} finally {
  server.kill();
  NodeFS.rmSync(temp, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ok: a card's dialog closes when the view leaves its card (mouse, desktop; touch, phone)");
