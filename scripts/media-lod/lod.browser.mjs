// End-to-end headless muted Chrome check for:
//   1. Game-style zoom LOD + off-screen bitmap culling (phone 3x DPR zoomed out vs zoomed in vs modal).
//   2. Settle button beside Tidy in CanvasSwitcher.
//   3. Follow quick toggle between Canvas and Mic (works with voice off, uses Canvas's active styling).
// Follows lalala-testing: separate temp server/state/port, --mute-audio Chrome, clean teardown.
// Run: node scripts/media-lod/lod.browser.mjs
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = NodePath.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a valid uncompressed-filter solid PNG of width×height (e.g. 2400×3200 -> 30.7 MB RGBA). */
function makePng(width, height, r, g, b) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const idat = NodeZlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const temp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-lod-e2e-")));
const cards = NodePath.join(temp, "cards");
NodeFS.mkdirSync(cards);

// 6 huge 2400×3200 PNGs (~30.7 MB decoded RGBA each = ~184 MB total raw!)
for (let i = 0; i < 6; i += 1) {
  NodeFS.writeFileSync(NodePath.join(cards, `big${i}.png`), makePng(2400, 3200, 40 + i * 30, 120, 200));
}

NodeFS.writeFileSync(
  NodePath.join(cards, "PhotoCard.tsx"),
  `import { useState } from "react";
export function PhotoCard({ src, title }: { src: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <img src={src} alt={title} style={{ width: "100%", height: "auto", display: "block" }} onClick={() => setOpen(true)} />
      {open ? <dialog open><img data-lalala-zoom-img="" src={src} alt={title} /></dialog> : null}
    </div>
  );
}
`,
);

NodeFS.writeFileSync(
  NodePath.join(cards, "index.tsx"),
  `import { CanvasCard } from "./CanvasCard";
import { PhotoCard } from "./PhotoCard";
import p0 from "./big0.png?url";
import p1 from "./big1.png?url";
import p2 from "./big2.png?url";
import p3 from "./big3.png?url";
import p4 from "./big4.png?url";
import p5 from "./big5.png?url";

export default function Cards() {
  const items = [
    ["card0", "Card 0", p0, 0, 0],
    ["card1", "Card 1", p1, 560, 0],
    ["card2", "Card 2", p2, 1120, 0],
    ["card3", "Card 3", p3, 0, 760],
    ["card4", "Card 4", p4, 560, 760],
    ["far5", "Far Card", p5, 9000, 9000],
  ] as const;
  return (
    <>
      {items.map(([id, title, src, x, y]) => (
        <CanvasCard key={id} id={id} title={title} exact at={{ x, y, w: 500, h: 680 }}>
          <PhotoCard src={src} title={title} />
        </CanvasCard>
      ))}
    </>
  );
}
`,
);

const state = NodePath.join(temp, "state");
const port = 5820 + Math.floor(Math.random() * 150);
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

const profile = NodeFS.mkdtempSync(NodePath.join(temp, "profile-"));
const debugPort = 9320 + Math.floor(Math.random() * 500);
let chrome;

try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => String(chunk).includes("lalala on") && resolve());
    server.on("exit", () => reject(new Error("lalala server exited before listening")));
  });

  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--mute-audio",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(
        (t) => t.type === "page",
      );
    } catch {}
  }
  if (!target) throw new Error("headless Chrome target did not open");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    pending.get(msg.id)?.(msg);
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      seq += 1;
      pending.set(seq, resolve);
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const evalPage = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result?.result?.value;
  };
  const waitUntil = async (expression, what, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      if (await evalPage(expression)) return;
      await sleep(150);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  // Phone viewport (390×844 @ 3x DPR, touch)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });

  const store = `import("/src/voice/extras/canvasStore.ts")`;
  await waitUntil(`${store}.then((s) => Object.keys(s.getCards()).length >= 6)`, "6 cards placed");

  // Place cards in a known grid with far5 genuinely off-screen, then zoom out to 0.18 (iPhone overview).
  await evalPage(`${store}.then((s) => {
    s.setCard("card0", { x: 0, y: 0, w: 500, h: 680 });
    s.setCard("card1", { x: 560, y: 0, w: 500, h: 680 });
    s.setCard("card2", { x: 1120, y: 0, w: 500, h: 680 });
    s.setCard("card3", { x: 0, y: 760, w: 500, h: 680 });
    s.setCard("card4", { x: 560, y: 760, w: 500, h: 680 });
    s.setCard("far5", { x: 9000, y: 9000, w: 500, h: 680 });
    s.setCamera({ x: 30, y: 80, z: 0.18 });
  })`);
  await waitUntil(
    `[...document.images].filter(i => i.getAttribute("src")?.startsWith("/__lalala/img") && i.complete && i.naturalWidth > 16).length >= 5`,
    "5 visible card images loaded as WebP LOD thumbnails",
  );
  await sleep(500);

  const overviewStats = await evalPage(`(() => {
    let bytes = 0;
    const imgs = [...document.images].map((img) => {
      if (img.complete) bytes += img.naturalWidth * img.naturalHeight * 4;
      return {
        alt: img.alt,
        src: img.getAttribute("src"),
        lod: img.dataset.lalalaLod ?? null,
        nw: img.naturalWidth,
        nh: img.naturalHeight,
      };
    });
    return { imgMB: Math.round((bytes / 1e6) * 100) / 100, count: imgs.length, imgs };
  })()`);

  console.log("Phone overview (z=0.18) decoded image stats:", JSON.stringify(overviewStats, null, 2));
  if (overviewStats.imgMB > 5) {
    throw new Error(`Expected decoded imgMB <= 5 MB on phone overview (raw is 184 MB), got ${overviewStats.imgMB} MB`);
  }
  const loadedThumbs = overviewStats.imgs.filter((i) => i.src?.startsWith("/__lalala/img"));
  if (loadedThumbs.length < 5) {
    throw new Error(`Expected >= 5 LOD thumbnails, got ${loadedThumbs.length}`);
  }
  if (loadedThumbs.some((i) => i.nw > 256)) {
    throw new Error(`Expected overview thumbnails <= 256 px wide, got: ${JSON.stringify(loadedThumbs)}`);
  }

  // Zoom IN close onto card0 -> card0 upgrades to sharper LOD (512/960), off-screen cards cull!
  await evalPage(`${store}.then((s) => s.setCamera({ x: 10, y: 60, z: 0.78 }))`);
  await waitUntil(
    `[...document.images].some(i => i.alt === "Card 0" && Number(i.dataset.lalalaLod) >= 512 && i.complete && i.naturalWidth >= 512)`,
    "Card 0 upgraded to >= 512 px LOD when zoomed in",
  );
  await sleep(450);

  const zoomedStats = await evalPage(`(() => {
    let bytes = 0;
    const imgs = [...document.images].map((img) => {
      if (img.complete) bytes += img.naturalWidth * img.naturalHeight * 4;
      return { alt: img.alt, lod: img.dataset.lalalaLod ?? null, nw: img.naturalWidth, nh: img.naturalHeight };
    });
    return { imgMB: Math.round((bytes / 1e6) * 100) / 100, imgs };
  })()`);
  console.log("Phone zoomed-in (z=0.78) stats:", JSON.stringify(zoomedStats));
  const culledCount = zoomedStats.imgs.filter((i) => i.lod === "culled" && i.nw <= 16).length;
  if (culledCount < 3) {
    throw new Error(`Expected >= 3 off-screen images actively culled to <=16px, got ${culledCount}`);
  }
  if (zoomedStats.imgMB > 12) {
    throw new Error(`Expected zoomed-in phone imgMB <= 12 MB (raw is 184 MB), got ${zoomedStats.imgMB} MB`);
  }

  // Zoom back OUT to 0.18 -> Card 0 downgrades back to <= 256 px to reclaim memory!
  await evalPage(`${store}.then((s) => s.setCamera({ x: 30, y: 80, z: 0.18 }))`);
  await waitUntil(
    `[...document.images].some(i => i.alt === "Card 0" && Number(i.dataset.lalalaLod) <= 256 && i.complete && i.naturalWidth <= 256)`,
    "Card 0 downgraded back to <= 256 px when zooming back out",
  );

  // Open ZoomImage-style modal on Card 0 -> untouched full 2400×3200 resolution!
  await evalPage(`document.querySelector('img[alt="Card 0"]')?.click()`);
  await waitUntil(
    `(() => { const z = document.querySelector('img[data-lalala-zoom-img]'); return Boolean(z && z.complete && z.naturalWidth === 2400); })()`,
    "Modal zoom image loaded at full 2400px resolution",
  );

  // Verify bar UI: Follow toggle between Canvas & Mic (voice OFF), active state uses data-open,
  // and Settle button sits right beside Tidy inside CanvasSwitcher!
  const uiCheck = await evalPage(`(async () => {
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const row = document.querySelector(".lalala-tabs");
    const slots = [...(row?.children ?? [])].map((el) => el.className);
    const follow = document.querySelector("[data-lalala-follow]");
    const canvasBtn = document.querySelector("[data-lalala-canvas-name]");
    if (!follow || !canvasBtn) return { ok: false, slots, reason: "missing tab" };
    // Toggle Follow ON and verify data-open + localStorage persistence
    follow.click();
    await tick();
    const afterOn = {
      dataOpen: follow.hasAttribute("data-open"),
      stored: localStorage.getItem("lalala:follow"),
    };
    follow.click();
    await tick();
    const afterOff = {
      dataOpen: follow.hasAttribute("data-open"),
      stored: localStorage.getItem("lalala:follow"),
    };
    // Open Canvas panel and check Tidy + Settle order
    canvasBtn.click();
    await tick();
    const actions = [...document.querySelectorAll("[data-lalala-canvas-actions] > button")].map((b) =>
      (b.textContent ?? "").trim(),
    );
    return { ok: true, slots, afterOn, afterOff, actions };
  })()`);
  console.log("UI check:", JSON.stringify(uiCheck));
  if (!uiCheck.ok) throw new Error(`UI check failed: ${JSON.stringify(uiCheck)}`);
  const ci = uiCheck.slots.indexOf("lalala-canvas-slot");
  const fi = uiCheck.slots.indexOf("lalala-follow-slot");
  const mi = uiCheck.slots.indexOf("lalala-mic-slot");
  if (!(ci >= 0 && fi === ci + 1 && mi === fi + 1)) {
    throw new Error(`Follow slot not right between canvas and mic: ${JSON.stringify(uiCheck.slots)}`);
  }
  if (!uiCheck.afterOn.dataOpen || uiCheck.afterOn.stored !== "1") {
    throw new Error(`Follow ON did not set data-open or persist: ${JSON.stringify(uiCheck.afterOn)}`);
  }
  if (uiCheck.afterOff.dataOpen || uiCheck.afterOff.stored !== "0") {
    throw new Error(`Follow OFF did not clear data-open or persist: ${JSON.stringify(uiCheck.afterOff)}`);
  }
  const tidyIdx = uiCheck.actions.indexOf("Tidy");
  const settleIdx = uiCheck.actions.indexOf("Settle");
  if (!(tidyIdx >= 0 && settleIdx === tidyIdx + 1)) {
    throw new Error(`Settle not right next to Tidy: ${JSON.stringify(uiCheck.actions)}`);
  }

  ws.close();
  console.log(
    `ok: phone decoded imgMB dropped from ~184 MB raw to ${overviewStats.imgMB} MB zoomed out (${zoomedStats.imgMB} MB zoomed in, ${culledCount} culled), modal full-res 2400px, Follow & Settle verified`,
  );
} finally {
  chrome?.kill();
  server.kill();
  await sleep(300);
  NodeFS.rmSync(temp, { recursive: true, force: true });
}
