/// <reference lib="webworker" />
import { LOGO, logoText } from "./asciiLogo";

/**
 * The boot logo off the main thread (bootLogo.ts): the mark turning on an OffscreenCanvas at its own
 * 25 fps, so module loading, card mounting and layout on the page can't make it stutter. Glyphs come
 * from an atlas drawn once; each frame copies them into place.
 */
type Start = {
  readonly type: "start";
  readonly canvas: OffscreenCanvas;
  readonly font: string;
  /** One glyph's box in canvas pixels (whole pixels, so each copy lands sharp). */
  readonly cell: { readonly w: number; readonly h: number };
  readonly scale: number;
  readonly still: boolean;
  readonly glitch: boolean;
};
type Message = Start | { readonly type: "glitch"; readonly on: boolean };

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let atlas: OffscreenCanvas | null = null;
const index = new Map<string, number>();
let cell = { w: 0, h: 0 };
let glitching = false;
let still = false;
let start = 0;
let count = 0;

function makeAtlas(font: string, scale: number) {
  const glyphs = LOGO.glyphs;
  atlas = new OffscreenCanvas(Math.ceil(cell.w * glyphs.length), Math.ceil(cell.h));
  const a = atlas.getContext("2d")!;
  a.scale(scale, scale);
  a.font = font;
  a.fillStyle = "#fff";
  a.textBaseline = "top";
  for (let i = 0; i < glyphs.length; i++) {
    a.fillText(glyphs[i]!, (i * cell.w) / scale, 0);
    index.set(glyphs[i]!, i);
  }
}

function paint(angle: number) {
  if (ctx === null || atlas === null) return;
  const text = logoText(angle, glitching ? ++count : null);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  let row = 0;
  let col = 0;
  for (const ch of text) {
    if (ch === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    const at = ch === " " ? undefined : index.get(ch);
    if (at !== undefined)
      ctx.drawImage(atlas, at * cell.w, 0, cell.w, cell.h, col * cell.w, row * cell.h, cell.w, cell.h);
    col += 1;
  }
}

function loop() {
  const now = performance.now();
  start ||= now;
  paint(LOGO.rest + (now - start) * LOGO.spin);
  self.setTimeout(loop, LOGO.frameMs);
}

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "start") {
    ctx = message.canvas.getContext("2d");
    cell = message.cell;
    still = message.still;
    glitching = message.glitch;
    makeAtlas(message.font, message.scale);
    if (still) paint(LOGO.rest);
    else loop();
  } else {
    glitching = message.on;
    if (still) paint(LOGO.rest);
  }
};

