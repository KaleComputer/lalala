// lalala's dev server: the voice plugin (speech, canvas layout, session log) plus the T3 bridge,
// and aliases that point the voice code's T3 Code imports at small stand-ins in src/t3 and src/state.
import * as NodePath from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { cardsDir, cardsPlugin } from "./vite/cards.mjs";
import { t3BridgePlugin } from "./vite/t3bridge.mjs";
import { lalalaPlugin } from "./vite/voice.ts";

const src = NodePath.join(import.meta.dirname, "src");
const t3 = (file) => NodePath.join(src, "t3", file);
const port = Number(process.env.LALALA_PORT || 5780);
// The brain's T3 project folder (this checkout unless LALALA_WORKSPACE_ROOT says otherwise); the
// user's cards live in its cards/ folder (vite/cards.mjs).
const brainRoot = NodePath.resolve(process.env.LALALA_WORKSPACE_ROOT?.trim() || import.meta.dirname);

export default defineConfig({
  plugins: [
    t3BridgePlugin({
      threadId: process.env.LALALA_THREAD_ID?.trim(),
      workspaceRoot: brainRoot,
    }),
    cardsPlugin({ dir: cardsDir(brainRoot), extrasDir: NodePath.join(src, "voice/extras") }),
    lalalaPlugin(),
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: [
      { find: /^~\//, replacement: `${src}/` },
      { find: "@t3tools/contracts", replacement: t3("contracts.ts") },
      { find: "@t3tools/client-runtime/environment", replacement: t3("clientRuntime.ts") },
      { find: "@t3tools/client-runtime/state/models", replacement: t3("clientRuntime.ts") },
      { find: "@t3tools/client-runtime/state/runtime", replacement: t3("clientRuntime.ts") },
      { find: "@t3tools/client-runtime/image-attachment-size", replacement: t3("imageAttachmentSize.ts") },
      { find: "@t3tools/shared/imageDimensions", replacement: t3("imageDimensions.ts") },
      { find: "@t3tools/shared/themePalettes", replacement: t3("themePalettes.ts") },
      { find: "@effect/atom-react", replacement: t3("atomReact.ts") },
      { find: "effect/DateTime", replacement: t3("dateTime.ts") },
      { find: "@tanstack/react-router", replacement: t3("router.ts") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    // A tunnel (NetBird, Tailscale) sends its own Host.
    allowedHosts: true,
    // The site's own build (site/out, site/.next) is no part of the app.
    watch: { ignored: ["**/site/**"] },
  },
});
