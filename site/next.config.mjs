import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The repo root: the page is the app's own canvas, imported from ../src/voice.
const root = fileURLToPath(new URL("..", import.meta.url));

// The app's topic sounds (src/voice/extras/topicSounds-*.mp3), served as /sounds/<name>.mp3.
const topicSounds = readdirSync(new URL("../src/voice/extras", import.meta.url))
  .flatMap((file) => /^topicSounds-(.+)\.mp3$/.exec(file)?.[1] ?? [])
  .sort();

/** Static export: the whole site is plain HTML, CSS and JS served from Vercel's CDN. */
const config = {
  output: "export",
  poweredByHeader: false,
  outputFileTracingRoot: root,
  // The app's own aliases (vite.config.mjs): T3 Code imports point at the small stand-ins in src/t3.
  turbopack: {
    root,
    resolveAlias: {
      "~/*": "../src/*",
      "@t3tools/contracts": "../src/t3/contracts.ts",
      "@t3tools/client-runtime/environment": "../src/t3/clientRuntime.ts",
      "@t3tools/client-runtime/state/models": "../src/t3/clientRuntime.ts",
      "@t3tools/client-runtime/state/runtime": "../src/t3/clientRuntime.ts",
      "@t3tools/client-runtime/image-attachment-size": "../src/t3/imageAttachmentSize.ts",
      "@t3tools/shared/imageDimensions": "../src/t3/imageDimensions.ts",
      "@t3tools/shared/themePalettes": "../src/t3/themePalettes.ts",
      "@effect/atom-react": "../src/t3/atomReact.ts",
      "effect/DateTime": "../src/t3/dateTime.ts",
      "@tanstack/react-router": "../src/t3/router.ts",
    },
  },
  env: { LALALA_TOPIC_SOUNDS: topicSounds.join(",") },
};

export default config;
