// A card that grows to fit its content must never cover another card, and a group that grows must
// never cover a loose card or another group. Cards land at their first size and grow once their
// content loads; they used to grow in place over their neighbours (20 Nov: a new card in Product
// grew from a phone-sized first box to 760×1600 over two cards and into two other groups). Also: a
// phone places a new card at the card's own size, not its narrow window's, since the layout is shared.
// Starts its own lalala per device (temp cards and state, its own port) and a headless, muted Chrome.
// Run: node scripts/canvas/grow.browser.mjs
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = NodePath.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Real path: macOS's temp folder is a symlink, and Vite serves the cards by their real path.
const temp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-grow-")));
const cards = NodePath.join(temp, "cards");
NodeFS.mkdirSync(cards);
NodeFS.writeFileSync(
  NodePath.join(cards, "Grow.tsx"),
  `import { useEffect, useState } from "react";
export function Grow() {
  const [big, setBig] = useState(false);
  useEffect(() => {
    const on = () => setBig(true);
    window.addEventListener("test-grow", on);
    return () => window.removeEventListener("test-grow", on);
  }, []);
  return <div data-test-grow="" style={{ width: big ? 1000 : 100, height: big ? 1400 : 60 }} />;
}
`,
);
const card = (id, group, x, y) =>
  `<CanvasCard id="${id}" ${group ? `group="${group}" ` : ""}title="${id}" at={{ x: ${x}, y: ${y}, w: 500, h: 300 }}><Grow /></CanvasCard>`;
NodeFS.writeFileSync(
  NodePath.join(cards, "index.tsx"),
  `import { CanvasCard } from "./CanvasCard";
import { Grow } from "./Grow";
export default function Cards() {
  return (
    <>
      ${card("a", "G", 0, 0)}
      ${card("grows", "G", 516, 0)}
      ${card("b", "G", 1032, 0)}
      ${card("c", "G", 0, 316)}
      ${card("d", "G", 516, 316)}
      ${card("solo", undefined, 1900, 0)}
      ${card("near", undefined, 2416, 0)}
      ${card("below", undefined, 1900, 316)}
    </>
  );
}
`,
);
// The tight layout each run starts from: every card 16 px from its neighbours, the loose ones
// 240 px right of the group's area.
const TIGHT = {
  a: [0, 0], grows: [516, 0], b: [1032, 0], c: [0, 316], d: [516, 316],
  solo: [1820, 0], near: [2336, 0], below: [1820, 316],
};

async function withServer(name, body) {
  const state = NodePath.join(temp, `state-${name}`);
  const port = 5800 + Math.floor(Math.random() * 190);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      LALALA_PORT: String(port),
      LALALA_CARDS_DIR: cards,
      LALALA_STATE_DIR: state,
      LALALA_CANVAS_FILE: NodePath.join(state, "canvas.json"),
      LALALA_SETTINGS_FILE: NodePath.join(state, "settings.json"),
      LALALA_LOG_DIR: NodePath.join(state, "logs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on("data", (chunk) => String(chunk).includes("lalala on") && resolve());
      server.on("exit", () => reject(new Error("lalala didn't start")));
    });
    return await body(port);
  } finally {
    server.kill();
  }
}

async function run(device, port) {
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
    if (device === "phone") {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    } else await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const store = `import("/src/voice/extras/canvasStore.ts")`;
    const boxes = `${store}.then((s) => JSON.stringify(s.getCards()))`;
    await until(`${store}.then((s) => Object.keys(s.getCards()).length >= 8)`, "the placed cards");

    const failures = [];
    const first = JSON.parse(await page(boxes));
    for (const [card, rect] of Object.entries(first)) {
      if (rect.w !== 500) failures.push(`${device}: ${card} was placed ${rect.w} px wide, not its own 500`);
    }

    await page(`${store}.then((s) => {
      for (const [id, [x, y]] of Object.entries(${JSON.stringify(TIGHT)})) s.setCard(id, { x, y, w: 500, h: 300 });
      s.setCamera({ x: 40, y: 120, z: ${device === "phone" ? 0.1 : 0.3} });
    })`);
    await sleep(500);
    await page(`window.dispatchEvent(new Event("test-grow"))`);
    await until(`${store}.then((s) => Object.values(s.getCards()).every((r) => r.w >= 1000 && r.h >= 1400))`, "every card grown");
    await sleep(500);

    const grown = JSON.parse(await page(boxes));
    const areas = await page(`${store}.then((s) => s.groupAreas().map((a) => a.rect))`);
    const overlap = (p, q) =>
      Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 0.5 &&
      Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > 0.5;
    const ids = Object.keys(grown);
    for (const [i, p] of ids.entries()) {
      for (const q of ids.slice(i + 1)) {
        if (overlap(grown[p], grown[q])) failures.push(`${device}: ${p} grew over ${q}`);
      }
    }
    for (const loose of ["solo", "near", "below"]) {
      if (areas.some((area) => overlap(area, grown[loose]))) failures.push(`${device}: group G grew over ${loose}`);
    }
    ws.close();
    return failures;
  } finally {
    chrome.kill();
    await sleep(300);
  }
}

let failures = [];
try {
  failures = [
    ...(await withServer("phone", (port) => run("phone", port))),
    ...(await withServer("desktop", (port) => run("desktop", port))),
  ];
} finally {
  NodeFS.rmSync(temp, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ok: growing cards never cover a card or a group's area; a phone places cards at their own size");
