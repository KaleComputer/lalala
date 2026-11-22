// On-demand, disk-cached WebP LOD thumbnails for canvas card images (`/__lalala/img?src=...&w=...`).
// Keeps zoomed-out and phone canvases far below iOS Jetsam limits: a 4096×5939 card image decodes to
// ~97 MB RGBA, while its 256 px WebP LOD decodes to ~0.38 MB (~250× less). Full resolution still
// loads untouched when zoomed in close on desktop or opened in ZoomImage.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { stateDir } from "./stateDir.mjs";

export const LOD_BUCKETS = [128, 256, 512, 960, 1600];
const RASTER_EXT = /\.(?:jpe?g|png|webp)$/i;
const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_CONCURRENT = 4;
const MAX_CACHE_FILES = 600;

/** Snaps any requested width to the nearest supported LOD bucket >= width, clamped to the table. */
export function snapBucket(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= LOD_BUCKETS[0]) return LOD_BUCKETS[0];
  for (const bucket of LOD_BUCKETS) {
    if (n <= bucket) return bucket;
  }
  return LOD_BUCKETS[LOD_BUCKETS.length - 1];
}

const inside = (dir, file) => {
  const rel = NodePath.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !NodePath.isAbsolute(rel);
};

/**
 * Resolves a local image URL pathname (`/@fs/...` or `/src/...`) to a verified real file path inside
 * one of `allowedRoots`, or null if outside, missing, or not a supported raster format.
 */
export function resolveImageFile(rawSrc, allowedRoots) {
  if (typeof rawSrc !== "string" || rawSrc === "" || !rawSrc.startsWith("/")) return null;
  let pathname = rawSrc.split("?")[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!RASTER_EXT.test(pathname)) return null;
  const roots = allowedRoots
    .filter(Boolean)
    .map((dir) => {
      try {
        return NodeFS.realpathSync(dir);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (roots.length === 0) return null;

  let candidate = null;
  if (pathname.startsWith("/@fs/")) {
    candidate = pathname.slice(4);
  } else {
    // Repo-relative path such as /src/voice/extras/foo.jpg or /assets/bar.png.
    for (const root of roots) {
      const joined = NodePath.resolve(root, pathname.replace(/^\/+/, ""));
      if (NodeFS.existsSync(joined)) {
        candidate = joined;
        break;
      }
    }
  }
  if (!candidate) return null;
  let realPath;
  try {
    realPath = NodeFS.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!roots.some((root) => inside(root, realPath))) return null;
  try {
    if (!NodeFS.statSync(realPath).isFile()) return null;
  } catch {
    return null;
  }
  return realPath;
}

/**
 * Fast header-only dimension reader (PNG, JPEG, WebP) so we never spawn an encoder to upscale an
 * image that is already <= the target bucket width. Returns `{ width, height }` or null.
 */
export function readImageDimensions(filePath) {
  let fd = -1;
  try {
    fd = NodeFS.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(65536);
    const len = NodeFS.readSync(fd, buf, 0, buf.length, 0);
    if (len < 24) return null;

    // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR at byte 16..23
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // WebP: RIFF....WEBP
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buf.toString("ascii", 12, 16);
      if (chunk === "VP8X" && len >= 30) {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height };
      }
      if (chunk === "VP8 " && len >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L" && len >= 25 && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }

    // JPEG: FF D8
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < len) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        while (offset < len && buf[offset] === 0xff) offset += 1;
        if (offset >= len) break;
        const marker = buf[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (offset + 2 > len) break;
        const size = buf.readUInt16BE(offset);
        if (size < 2 || offset + size > len) break;
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
        }
        offset += size;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try {
        NodeFS.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

function findBinary(candidates) {
  for (const bin of candidates) {
    if (bin.startsWith("/")) {
      if (NodeFS.existsSync(bin)) return bin;
      continue;
    }
    try {
      const found = NodeChildProcess.execFileSync("which", [bin], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (found) return found;
    } catch {}
  }
  return null;
}

function runCommand(bin, args) {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(bin, args, { timeout: 20_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pruneCacheDir(cacheDir) {
  try {
    const entries = NodeFS.readdirSync(cacheDir)
      .filter((name) => !name.endsWith(".tmp"))
      .map((name) => {
        const full = NodePath.join(cacheDir, name);
        try {
          return { full, mtimeMs: NodeFS.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (entries.length <= MAX_CACHE_FILES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries.slice(0, entries.length - Math.floor(MAX_CACHE_FILES * 0.8))) {
      NodeFS.rmSync(entry.full, { force: true });
    }
  } catch {}
}

export function imageLodPlugin({ dir, root }) {
  const allowedRoots = [dir, root];
  const cacheDir = NodePath.join(stateDir(), "img-lod-cache");
  const cwebp = findBinary(["/opt/homebrew/bin/cwebp", "/usr/local/bin/cwebp", "cwebp"]);
  const sips = findBinary(["/usr/bin/sips", "sips"]);
  const inFlight = new Map();
  let active = 0;
  const queue = [];

  const withSlot = (work) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        work()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (active < MAX_CONCURRENT) run();
      else queue.push(run);
    });

  async function encodeThumbnail(realPath, bucket, key) {
    NodeFS.mkdirSync(cacheDir, { recursive: true });
    const preferWebp = cwebp !== null;
    const ext = preferWebp ? "webp" : "jpg";
    const target = NodePath.join(cacheDir, `${key}.${ext}`);
    const contentType = preferWebp ? "image/webp" : "image/jpeg";
    if (NodeFS.existsSync(target)) return { file: target, contentType };

    const existing = inFlight.get(key);
    if (existing) return existing;

    const job = withSlot(async () => {
      if (NodeFS.existsSync(target)) return { file: target, contentType };
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      const quality = bucket <= 256 ? 75 : bucket <= 512 ? 84 : bucket <= 960 ? 88 : 90;
      try {
        if (cwebp) {
          await runCommand(cwebp, [
            "-quiet",
            "-metadata",
            "icc,exif",
            "-resize",
            String(bucket),
            "0",
            "-q",
            String(quality),
            realPath,
            "-o",
            tmp,
          ]);
          NodeFS.renameSync(tmp, target);
          return { file: target, contentType: "image/webp" };
        }
        if (sips) {
          const jpgTarget = NodePath.join(cacheDir, `${key}.jpg`);
          const jpgTmp = `${jpgTarget}.${process.pid}.${Date.now()}.tmp.jpg`;
          await runCommand(sips, [
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            String(quality),
            "--resampleWidth",
            String(bucket),
            realPath,
            "--out",
            jpgTmp,
          ]);
          NodeFS.renameSync(jpgTmp, jpgTarget);
          return { file: jpgTarget, contentType: "image/jpeg" };
        }
        return null;
      } catch {
        NodeFS.rmSync(tmp, { force: true });
        // Fall back to sips if cwebp cannot decode an unusual image variant.
        if (cwebp && sips) {
          const jpgTarget = NodePath.join(cacheDir, `${key}.jpg`);
          const jpgTmp = `${jpgTarget}.${process.pid}.${Date.now()}.tmp.jpg`;
          try {
            await runCommand(sips, [
              "-s",
              "format",
              "jpeg",
              "-s",
              "formatOptions",
              String(quality),
              "--resampleWidth",
              String(bucket),
              realPath,
              "--out",
              jpgTmp,
            ]);
            NodeFS.renameSync(jpgTmp, jpgTarget);
            return { file: jpgTarget, contentType: "image/jpeg" };
          } catch {
            NodeFS.rmSync(jpgTmp, { force: true });
          }
        }
        return null;
      } finally {
        pruneCacheDir(cacheDir);
      }
    }).finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, job);
    return job;
  }

  return {
    name: "lalala:image-lod",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? "";
        if (!rawUrl.startsWith("/__lalala/img")) return next();
        const url = new URL(rawUrl, "http://lalala.local");
        if (url.pathname !== "/__lalala/img") return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405).end();
          return;
        }
        const src = url.searchParams.get("src") ?? "";
        const bucket = snapBucket(url.searchParams.get("w"));
        const realPath = resolveImageFile(src, allowedRoots);
        if (realPath === null) {
          res.writeHead(404).end();
          return;
        }
        let stat;
        try {
          stat = NodeFS.statSync(realPath);
        } catch {
          res.writeHead(404).end();
          return;
        }
        const qualityTag = bucket <= 256 ? 75 : bucket <= 512 ? 84 : bucket <= 960 ? 88 : 90;
        const key = NodeCrypto.createHash("sha256")
          .update(`${realPath}\0${stat.mtimeMs}\0${stat.size}\0${bucket}\0q${qualityTag}`)
          .digest("hex")
          .slice(0, 24);
        const etag = `"${key}"`;
        const versioned = url.searchParams.has("v") || url.searchParams.has("t");
        const cacheControl = versioned ? "public, max-age=31536000, immutable" : "public, max-age=60";

        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, {
            etag,
            "cache-control": cacheControl,
            "cross-origin-resource-policy": "same-origin",
          });
          res.end();
          return;
        }

        const serveFile = (filePath, contentType) => {
          if (res.writableEnded) return;
          let fileStat;
          try {
            fileStat = NodeFS.statSync(filePath);
          } catch {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            "content-type": contentType,
            "content-length": String(fileStat.size),
            etag,
            "cache-control": cacheControl,
            "cross-origin-resource-policy": "same-origin",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          NodeFS.createReadStream(filePath).pipe(res);
        };

        const originalMime =
          MIME_BY_EXT[NodePath.extname(realPath).toLowerCase()] ?? "application/octet-stream";
        const dims = readImageDimensions(realPath);
        // Never upscale an image whose natural width is already <= the requested LOD bucket.
        if (dims !== null && dims.width > 0 && dims.width <= bucket) {
          serveFile(realPath, originalMime);
          return;
        }

        void encodeThumbnail(realPath, bucket, key).then((result) => {
          if (result !== null) serveFile(result.file, result.contentType);
          else serveFile(realPath, originalMime);
        });
      });
    },
  };
}
