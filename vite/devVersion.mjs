// GET /__lalala/dev-version → { boot, seq }: seq counts source changes since this server started.
// A page that reconnects its HMR socket after the phone was locked (src/voice/hmrReconnect.ts)
// compares it with what it saw before, so it knows whether hot updates went by while it slept.
import * as NodePath from "node:path";

const ROUTE = "/__lalala/dev-version";

export function devVersionPlugin() {
  const boot = `${process.pid}-${Date.now()}`;
  let seq = 0;
  return {
    name: "lalala-dev-version",
    enforce: "pre",
    configureServer(server) {
      const src = NodePath.join(server.config.root, "src") + NodePath.sep;
      const html = NodePath.join(server.config.root, "index.html");
      const bump = (file) => {
        if ((file.startsWith(src) || file === html) && !file.endsWith(".mirror-tmp")) seq += 1;
      };
      for (const event of ["add", "change", "unlink"]) server.watcher.on(event, bump);
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== ROUTE) return next();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ boot, seq }));
      });
    },
  };
}
