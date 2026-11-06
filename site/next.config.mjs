import { fileURLToPath } from "node:url";

// The repo root, so the page imports the app's own voice bar from ../src/voice.
const root = fileURLToPath(new URL("..", import.meta.url));

/** Static export: the whole site is plain HTML, CSS and JS served from Vercel's CDN. */
const config = {
  output: "export",
  poweredByHeader: false,
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
