// The app is cross-origin isolated like lalala.talk (site/vercel.json): the in-browser speech models
// then run their WASM on several threads (single-threaded, a phone's Kokoro took 12 s for a 4 s
// sentence). A brain card's outside pictures then need /x/, the same proxy lalala.talk uses.
import { Readable } from "node:stream";

import { GET } from "../site/api/x.mjs";

export function isolationPlugin() {
  return {
    name: "lalala-isolation",
    config: () => ({
      server: {
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      },
    }),
    configureServer(server) {
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
