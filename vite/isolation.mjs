// The app is cross-origin isolated like lalala.talk (site/vercel.json): the in-browser speech models
// then run their WASM on several threads (single-threaded, a phone's Kokoro took 12 s for a 4 s
// sentence). A brain card's outside pictures then need /x/, the same proxy lalala.talk uses.
import { Readable } from "node:stream";

import { GET } from "../site/api/x.mjs";

export function isolationPlugin() {
  return {
    name: "lalala-isolation",
    configureServer(server) {
      // Every response, worker scripts (?worker_file) included: Chrome won't start a dedicated worker
      // without COEP on an isolated page, and Vite's worker route skips server.headers.
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        next();
      });
      server.middlewares.use("/x/", (req, res) => {
        const url = new URL(`/x${req.url ?? "/"}`, "http://lalala.local");
        const request = new Request(url, { headers: { accept: String(req.headers.accept ?? "*/*") } });
        GET(request)
          .then((response) => {
            res.writeHead(response.status, Object.fromEntries(response.headers));
            if (response.body) Readable.fromWeb(response.body).pipe(res);
            else res.end();
          })
          .catch(() => res.writeHead(502).end());
      });
    },
  };
}
