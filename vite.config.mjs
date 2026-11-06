// lalala's dev server: the voice plugin (speech, canvas layout, session log) plus the T3 bridge,
// and aliases that point the voice code's T3 Code imports at small stand-ins in src/t3 and src/state.
import * as NodePath from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { t3BridgePlugin } from "./vite/t3bridge.mjs";
import { lalalaPlugin } from "./vite/voice.ts";

const src = NodePath.join(import.meta.dirname, "src");
const t3 = (file) => NodePath.join(src, "t3", file);
const port = Number(process.env.LALALA_PORT || 5780);

export default defineConfig({
  plugins: [
    t3BridgePlugin({
      threadId: process.env.LALALA_THREAD_ID?.trim(),
      workspaceRoot: import.meta.dirname,
    }),
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
  },
});
