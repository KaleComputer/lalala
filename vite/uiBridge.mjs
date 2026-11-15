// The brain's hands on the canvas: `POST /__lalala/ui` runs one ui-sdk bridge call (snapshot,
// query, act, undo) in the page the user is looking at (src/voice/uiBridge.ts) and returns its
// result. One page answers, never every device, so a press doesn't land twice.

const TIMEOUT_MS = 20_000;
const TOOLS = new Set(["snapshot", "query", "act", "undo", "history"]);

const loopback = (req) =>
  !req.headers["x-forwarded-for"] &&
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

export function uiBridgePlugin() {
  return {
    name: "lalala-ui-bridge",
    apply: "serve",
    configureServer(server) {
      /** Each page's last word on whether it's seen, and when the user last touched it. */
      const pages = new Map();
      const waiting = new Map();
      let next = 0;

      server.ws.on("lalala:ui-here", (data, client) => pages.set(client, data));
      server.ws.on("lalala:ui-result", (data) => waiting.get(data?.id)?.(data.result));

      const pick = () => {
        for (const client of pages.keys()) if (client.socket?.readyState !== 1) pages.delete(client);
        const live = [...pages].filter(([, page]) => page.visible);
        const pool = live.length > 0 ? live : [...pages];
        return pool.sort(([, a], [, b]) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0))[0]?.[0];
      };

      server.middlewares.use("/__lalala/ui", async (req, res) => {
        const reply = (status, body) => {
          res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(body));
        };
        if (!loopback(req)) return reply(403, { error: "only from this machine" });
        let call;
        try {
          const url = new URL(req.url ?? "", "http://x");
          call =
            req.method === "POST"
              ? JSON.parse((await readBody(req)) || "{}")
              : { tool: url.searchParams.get("tool") ?? "snapshot", filter: url.searchParams.get("filter") ?? undefined };
        } catch {
          return reply(400, { error: "body must be JSON: {\"tool\": \"snapshot\"|\"query\"|\"act\"|\"undo\", …}" });
        }
        if (!TOOLS.has(call?.tool)) return reply(400, { error: `tool must be one of ${[...TOOLS].join(", ")}` });
        const client = pick();
        if (!client) return reply(503, { error: "no canvas is open in a browser" });
        const id = `u${(next += 1)}`;
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: "the page didn't answer in time" }), TIMEOUT_MS);
          waiting.set(id, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          client.send("lalala:ui-call", { id, call });
        });
        waiting.delete(id);
        reply(200, result);
      });
    },
  };
}
