// Game-style zoom LOD and server thumbnail security/bucketing checks.
// Run: node --experimental-strip-types --test scripts/media-lod/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import {
  canProxyLod,
  chooseLodBucket,
  isPhoneViewport,
  lodUrlFor,
  placeholderDataUrl,
  shouldDowngrade,
} from "../../src/voice/extras/mediaLodMath.ts";
import {
  readImageDimensions,
  resolveImageFile,
  snapBucket,
} from "../../vite/imageLod.mjs";

test("phone zoomed out picks tiny WebP LOD buckets and stays sharp when readable", () => {
  // Phone at zoom 0.18: a 500 px wide card is 90 CSS px wide on screen -> tiny preview.
  const bucket = chooseLodBucket({
    screenCssW: 90,
    screenCssH: 130,
    zoom: 0.18,
    dpr: 3,
    phone: true,
    inModal: false,
    forceFull: false,
  });
  assert.equal(bucket, 128);

  // Readable 360px tweet diagram at z=0.45 (162 CSS px) gets crisp 512px instead of blurry 256px.
  const tweetMid = chooseLodBucket({
    screenCssW: 162,
    screenCssH: 69,
    zoom: 0.45,
    dpr: 3,
    phone: true,
    inModal: false,
    forceFull: false,
  });
  assert.equal(tweetMid, 512);

  // Readable 360px tweet diagram at z=0.75 (270 CSS px) gets crisp 960px inline.
  const tweetClose = chooseLodBucket({
    screenCssW: 270,
    screenCssH: 115,
    zoom: 0.75,
    dpr: 3,
    phone: true,
    inModal: false,
    forceFull: false,
  });
  assert.equal(tweetClose, 960);

  // Opening ZoomImage modal always loads untouched full resolution.
  const modal = chooseLodBucket({
    screenCssW: 390,
    screenCssH: 560,
    zoom: 0.18,
    dpr: 3,
    phone: true,
    inModal: true,
    forceFull: false,
  });
  assert.equal(modal, Infinity);
});

test("desktop zoomed out uses lightweight previews and stays full resolution when reading", () => {
  const overview = chooseLodBucket({
    screenCssW: 110,
    screenCssH: 80,
    zoom: 0.15,
    dpr: 2,
    phone: false,
    inModal: false,
    forceFull: false,
  });
  assert.equal(overview, 256);

  // Desktop at z >= 0.65 (reading a 360px tweet card or diagram) gets full lossless resolution.
  const tweetDesktop = chooseLodBucket({
    screenCssW: 252,
    screenCssH: 108,
    zoom: 0.7,
    dpr: 2,
    phone: false,
    inModal: false,
    forceFull: false,
  });
  assert.equal(tweetDesktop, Infinity);
});

test("zooming back out always reclaims oversized bitmaps on phone and desktop", () => {
  assert.equal(shouldDowngrade(960, 512, true), true);
  assert.equal(shouldDowngrade(960, 256, true), true);
  assert.equal(shouldDowngrade(Infinity, 512, true), true);
  assert.equal(shouldDowngrade(256, 256, true), false);
  assert.equal(shouldDowngrade(512, 256, false), true);
  assert.equal(shouldDowngrade(1600, 960, false), true);
  assert.equal(shouldDowngrade(Infinity, 256, false), true);
});

test("only same-origin raster card/asset URLs go through /__lalala/img and cache-busters survive", () => {
  const origin = "http://127.0.0.1:5780";
  assert.equal(canProxyLod("/@fs/tmp/cards/shot.png?t=42", origin, true), true);
  assert.equal(canProxyLod("/src/voice/extras/bg.jpg", origin, true), true);
  assert.equal(canProxyLod("/@fs/tmp/cards/shot.png", origin, false), false);
  assert.equal(canProxyLod("data:image/svg+xml,<svg/>", origin, true), false);
  assert.equal(canProxyLod("blob:http://127.0.0.1:5780/abc", origin, true), false);
  assert.equal(canProxyLod("/@fs/tmp/cards/anim.gif", origin, true), false);
  assert.equal(canProxyLod("/__lalala/img?src=/a.png&w=256", origin, true), false);
  assert.equal(canProxyLod("https://example.com/pic.jpg", origin, true), false);

  assert.equal(
    lodUrlFor("/@fs/tmp/cards/shot.png?v=7", 256, origin),
    "/__lalala/img?src=%2F%40fs%2Ftmp%2Fcards%2Fshot.png&w=256&v=7",
  );
  assert.equal(isPhoneViewport(390, 844, true), true);
  assert.equal(isPhoneViewport(1440, 900, false), false);
});

test("placeholderDataUrl preserves aspect ratio within <= 16 px decoded footprint", () => {
  const portrait = placeholderDataUrl(4096, 5939);
  assert.match(portrait, /width='11' height='16'/);
  const landscape = placeholderDataUrl(2880, 1800);
  assert.match(landscape, /width='16' height='10'/);
  const unknown = placeholderDataUrl(0, 0);
  assert.ok(unknown.startsWith("data:image/gif;base64,"));
});

test("server snapBucket, PNG dimension reader, and path-traversal guard hold", () => {
  assert.equal(snapBucket(50), 128);
  assert.equal(snapBucket(256), 256);
  assert.equal(snapBucket(300), 512);
  assert.equal(snapBucket(9999), 1600);

  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-lod-")));
  const outside = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-out-")));
  try {
    // Minimal valid 1234x567 PNG header (IHDR).
    const png = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1234, 16);
    png.writeUInt32BE(567, 20);
    const insideFile = NodePath.join(dir, "sample.png");
    const outsideFile = NodePath.join(outside, "secret.png");
    NodeFS.writeFileSync(insideFile, png);
    NodeFS.writeFileSync(outsideFile, png);

    assert.deepEqual(readImageDimensions(insideFile), { width: 1234, height: 567 });
    assert.equal(resolveImageFile(`/@fs${insideFile}`, [dir]), insideFile);
    assert.equal(resolveImageFile(`/@fs${outsideFile}`, [dir]), null);
    assert.equal(resolveImageFile(`/@fs${dir}/../${NodePath.basename(outside)}/secret.png`, [dir]), null);
    assert.equal(resolveImageFile(`/@fs${dir}/notes.txt`, [dir]), null);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.rmSync(outside, { recursive: true, force: true });
  }
});
