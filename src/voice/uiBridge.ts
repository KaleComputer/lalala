// The brain reads and sets the canvas's ui-sdk controls through vite/uiBridge.mjs: the dev server
// sends one call to the page the user last touched, and this page answers it with ui-sdk's bridge.
// Controls marked `data-agent-confirm` refuse the brain ("Needs a person"), so it asks instead.
import { createAgent, type AgentComponent, type AgentStep } from "@ui-sdk/react/agent";
import { createHistory, describeEntry } from "@ui-sdk/react/history";

type Call =
  | { tool: "snapshot"; filter?: string }
  | { tool: "query"; text?: string; within?: string; kind?: string }
  | { tool: "act"; steps: AgentStep[] }
  | { tool: "undo"; count?: number }
  | { tool: "history" };

const agent = createAgent();
const history = createHistory(agent);

const words = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const matches = (component: AgentComponent, filter: string) =>
  words(`${component.label ?? ""} ${component.row ?? ""}`).includes(words(filter));

/** Entries an undo already put back, and the entries the undo itself made, which are never undone. */
const settled = new Set<string>();

/** The brain's last `count` changes, put back newest first; presses without a value can't be. */
async function undo(count: number) {
  const done = history
    .entries()
    .filter((entry) => entry.source === "agent" && !entry.reverted && !entry.redacted && !settled.has(entry.id))
    .slice(-count)
    .reverse();
  if (done.length === 0) return { ok: true, undone: [], note: "nothing the brain changed is left to undo" };
  const before = new Set(history.entries().map((entry) => entry.id));
  const result = await agent.act({
    steps: done.map((entry) => ({
      ref: entry.ref,
      action: `set${entry.key[0]!.toUpperCase()}${entry.key.slice(1)}`,
      args: [entry.previous],
    })),
  });
  for (const entry of done) settled.add(entry.id);
  for (const entry of history.entries()) if (!before.has(entry.id)) settled.add(entry.id);
  return { ...result, undone: done.map(describeEntry) };
}

async function run(call: Call): Promise<unknown> {
  switch (call.tool) {
    case "snapshot": {
      const all = agent.snapshot();
      return call.filter ? all.filter((component) => matches(component, call.filter!)) : all;
    }
    case "query":
      return agent.query({ text: call.text, within: call.within, kind: call.kind });
    case "act":
      return agent.act({ steps: call.steps ?? [] });
    case "undo":
      return undo(Math.max(1, Math.min(20, Math.floor(call.count ?? 1))));
    case "history":
      return history
        .entries()
        .slice(-20)
        .map((entry) => ({ ...(entry.reverted ? { reverted: true } : {}), said: describeEntry(entry) }));
  }
}

const hot = import.meta.hot;
if (hot) {
  let touchedAt = Date.now();
  const here = () =>
    hot.send("lalala:ui-here", { visible: document.visibilityState === "visible", touchedAt });
  for (const type of ["pointerdown", "keydown"] as const) {
    addEventListener(
      type,
      () => {
        if (Date.now() - touchedAt < 2000) return;
        touchedAt = Date.now();
        here();
      },
      { capture: true, passive: true },
    );
  }
  document.addEventListener("visibilitychange", here);
  hot.on("vite:ws:connect", here);
  here();

  hot.on("lalala:ui-call", async ({ id, call }: { id: string; call: Call }) => {
    let result: unknown;
    try {
      result = await run(call);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    hot.send("lalala:ui-result", { id, result });
  });
}
