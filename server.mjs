// t3voice: `node server.mjs` serves the canvas (Vite, so the brain's edits to src/voice hot-reload);
// `node server.mjs pair` pairs it with T3 Code once (scoped bearer session, nothing secret printed).
import * as NodeFS from "node:fs";

const envFile = new URL("./.env", import.meta.url).pathname;
if (NodeFS.existsSync(envFile)) process.loadEnvFile(envFile);

const { keepSessionFresh, pair } = await import("./vite/t3client.mjs");

if (process.argv[2] === "pair") {
  const result = await pair();
  console.log(`paired (${result.scope}), session valid until ${result.expiresAt}`);
  process.exit(0);
}

if (!process.env.T3VOICE_THREAD_ID?.trim()) {
  console.error(
    "T3VOICE_THREAD_ID is not set. Create the brain thread in T3 Code and put its id in .env (see README).",
  );
  process.exit(1);
}

const port = Number(process.env.T3VOICE_PORT || 5780);
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= "true";

keepSessionFresh();

const { createServer } = await import("vite");
const server = await createServer({ configFile: new URL("./vite.config.mjs", import.meta.url).pathname });
await server.listen();
console.log(`t3voice on http://127.0.0.1:${port}`);
