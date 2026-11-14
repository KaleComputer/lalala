// lalala: `node server.mjs` serves the canvas (Vite, so the brain's edits to src/voice hot-reload);
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

const port = Number(process.env.LALALA_PORT || 5780);
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= "true";

keepSessionFresh();

const { createServer } = await import("vite");
const { devVersionPlugin } = await import("./vite/devVersion.mjs");
const server = await createServer({
  configFile: new URL("./vite.config.mjs", import.meta.url).pathname,
  plugins: [devVersionPlugin()],
});
await server.listen();
console.log(`lalala on http://127.0.0.1:${port}`);
