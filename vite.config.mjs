// lalala, both hosts from one index.html and src/main.tsx. `vite` is the app: the dev server with
// the voice plugin (speech, canvas layout, session log), the T3 bridge and the user's cards.
// `vite build --mode site` is lalala.talk: a static build into site/out for Vercel, no server
// routes, no private cards. Aliases point the voice code's T3 Code imports at stand-ins in src/t3.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { cardsDir, cardsPlugin } from "./vite/cards.mjs";
import { imageLodPlugin } from "./vite/imageLod.mjs";
import { isolationPlugin } from "./vite/isolation.mjs";
import { leakGuardPlugin } from "./vite/leakGuard.mjs";
import { t3BridgePlugin } from "./vite/t3bridge.mjs";
import { uiBridgePlugin } from "./vite/uiBridge.mjs";
import { lalalaPlugin } from "./vite/voice.ts";
import { buildVersion } from "./site/version.mjs";

/**
 * Every ui-sdk entry, bundled up front: a card that first imports one at runtime would make Vite
 * re-bundle and reload the page, and until then the page holds two Reacts and its cards fail.
 */
const uiSdkEntries = ["@ui-sdk/react", "@ui-sdk/core"].flatMap((name) => {
  const pkg = JSON.parse(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "node_modules", name, "package.json"), "utf8"),
  );
  return Object.keys(pkg.exports ?? {})
    .filter((entry) => !/\.(css|json)$/.test(entry))
    .map((entry) => (entry === "." ? name : `${name}/${entry.slice(2)}`));
});

/** The host, from the mode: lalala.talk's static build, or the app with its server. */
const hostOf = (mode) => (mode === "site" ? "site" : "app");

const src = NodePath.join(import.meta.dirname, "src");
const t3 = (file) => NodePath.join(src, "t3", file);
const port = Number(process.env.LALALA_PORT || 5780);
// The brain's T3 project folder (this checkout unless LALALA_WORKSPACE_ROOT says otherwise); the
// user's cards live in its cards/ folder (vite/cards.mjs).
const brainRoot = NodePath.resolve(
  process.env.LALALA_WORKSPACE_ROOT?.trim() || import.meta.dirname,
);

/** The version label's stamp (site/version.mjs): baked in, and live at /__lalala-version in dev. */
function versionPlugin() {
  const root = import.meta.dirname;
  return {
    name: "lalala-version",
    config: (_, { command, mode }) => ({
      define: {
        "process.env.LALALA_VERSION": JSON.stringify(
          JSON.stringify(
            buildVersion(
              root,
              command === "serve"
                ? "local dev"
                : hostOf(mode) === "site" && process.env.VERCEL_ENV === "production"
                  ? "lalala.talk"
                  : (process.env.VERCEL_ENV ?? "local build"),
            ),
          ),
        ),
      },
    }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/__lalala-version") return next();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(buildVersion(root, "local dev")));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const site = hostOf(mode) === "site";
  return {
    define: {
      "import.meta.env.LALALA_HOST": JSON.stringify(hostOf(mode)),
      // The brain reaches the page's controls through this machine's own port (vite/uiBridge.mjs).
      "import.meta.env.LALALA_PORT": JSON.stringify(port),
    },
    plugins: [
      ...(site
        ? [leakGuardPlugin({ root: import.meta.dirname })]
        : [
            t3BridgePlugin({
              threadId: process.env.LALALA_THREAD_ID?.trim(),
              workspaceRoot: brainRoot,
            }),
            // The user's own cards: the app only; lalala.talk carries none of them.
            cardsPlugin({
              dir: cardsDir(brainRoot),
              extrasDir: NodePath.join(src, "voice/extras"),
            }),
            imageLodPlugin({
              dir: cardsDir(brainRoot),
              root: import.meta.dirname,
            }),
            // Before lalalaPlugin, whose /__lalala routes answer every other path.
            uiBridgePlugin(),
            lalalaPlugin(),
            isolationPlugin(),
          ]),
      versionPlugin(),
      tailwindcss(),
      react(),
    ],
    build: { outDir: "site/out", emptyOutDir: true },
    optimizeDeps: { include: uiSdkEntries },
    // Speech and the logo run in module workers that split into chunks.
    worker: { format: "es" },
    resolve: {
      alias: [
        { find: /^~\//, replacement: `${src}/` },
        { find: "@t3tools/contracts", replacement: t3("contracts.ts") },
        { find: "@t3tools/client-runtime/environment", replacement: t3("clientRuntime.ts") },
        { find: "@t3tools/client-runtime/state/models", replacement: t3("clientRuntime.ts") },
        { find: "@t3tools/client-runtime/state/runtime", replacement: t3("clientRuntime.ts") },
        {
          find: "@t3tools/client-runtime/image-attachment-size",
          replacement: t3("imageAttachmentSize.ts"),
        },
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
  };
});
