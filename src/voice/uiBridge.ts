// The brain reads and sets the canvas's ui-sdk controls through vite/uiBridge.mjs: the dev server
// sends one call to the page the user last touched, and this page answers it with ui-sdk's bridge.
// Controls marked `data-agent-confirm` refuse the brain ("Needs a person"), so it asks instead.
import { createAgent, type AgentStep, type ObservedChange } from "@ui-sdk/react/agent";
import { elementOf } from "@ui-sdk/react/observe";

type Call =
  | { tool: "snapshot"; filter?: string }
  | { tool: "query"; text?: string; within?: string; kind?: string }
  | { tool: "act"; steps: AgentStep[]; card?: string }
  | { tool: "undo"; count?: number }
  | { tool: "history" };

type Change = { ref: string; label?: string; key: string; previous: unknown; value: unknown };

const agent = createAgent();
const UNDOABLE = new Set(["value", "checked", "pressed", "open"]);
/** The brain's acts, oldest first, each with what it changed: one "undo" puts back one act. */
const done: { said: string; changes: Change[] }[] = [];

const words = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const missing = (result: { ok: boolean; error?: { message: string } }) =>
  !result.ok && /^No component/.test(result.error?.message ?? "");

/** Moves the view to a card (its title or id), so a card that isn't drawn mounts its controls. */
async function reveal(card: string, ref: string) {
  if (!globalThis.__lalalaCanvases?.focus(card)) return false;
  for (let tries = 0; tries < 30; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = await agent.query({ text: ref });
    if (Array.isArray(found) && found.some((component) => !component.offPage && !component.disabled)) return true;
  }
  return false;
}

async function act(steps: AgentStep[], card: string | undefined) {
  const seen: ObservedChange[] = [];
  const stop = agent.subscribe((change) => {
    if (change.source === "agent") seen.push(change);
  });
  let result = await agent.act({ steps });
  if (card && missing(result) && (await reveal(card, steps[result.error!.step]?.ref ?? ""))) {
    result = await agent.act({ steps: steps.slice(result.error!.step) });
  }
  // Change reports settle after the act's own promise.
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  // Everything the act set off counts, like a picked take that starts playing, so one undo puts it all back.
  const changes = new Map<string, Change>();
  for (const change of seen) {
    const id = `${change.ref} ${change.key}`;
    if (!UNDOABLE.has(change.key) || change.value === "[redacted]") continue;
    const first = changes.get(id);
    changes.set(id, {
      ref: change.ref,
      label: change.label,
      key: change.key,
      previous: first ? first.previous : change.previous,
      value: change.value,
    });
  }
  // A toggle or switch that reported only its new state was the other one before.
  for (const step of result.steps ?? []) {
    for (const change of step.changes ?? []) {
      const ref = change.label === undefined ? step.ref : (refOf(change.label) ?? step.ref);
      const id = `${ref} ${change.key}`;
      if (changes.has(id) || typeof change.value !== "boolean" || !UNDOABLE.has(change.key)) continue;
      changes.set(id, { ref, label: change.label, key: change.key, previous: !change.value, value: change.value });
    }
  }
  const kept = [...changes.values()].filter((change) => JSON.stringify(change.previous) !== JSON.stringify(change.value));
  if (kept.length > 0) {
    const said = kept.map((change) => `${change.label ?? change.ref} ${change.key} → ${JSON.stringify(change.value)}`).join(", ");
    done.push({ said, changes: kept });
    if (done.length > 50) done.shift();
  }
  return result;
}

function labelOf(ref: string) {
  return agent.snapshot().find((component) => component.ref === ref)?.label;
}

function refOf(label: string) {
  return agent.snapshot().find((component) => component.label === label)?.ref;
}

/** The brain's last `count` acts, put back newest first; a press with no value to restore can't be. */
async function undo(count: number) {
  const taken = done.splice(Math.max(0, done.length - count)).reverse();
  if (taken.length === 0) return { ok: true, undone: [], note: "nothing the brain changed is left to undo" };
  const steps = taken.flatMap((entry) =>
    [...entry.changes].reverse().map((change) => ({
      ref: change.ref,
      action: `set${change.key[0]!.toUpperCase()}${change.key.slice(1)}`,
      args: [change.previous],
    })),
  );
  // One step at a time: a value the card no longer offers (a take hidden by a filter) skips, the rest go back.
  const notPutBack: string[] = [];
  for (const step of steps) {
    const result = await agent.act({ steps: [step] });
    if (!result.ok) notPutBack.push(result.error?.message ?? `${step.ref} ${step.action}`);
    // A control that now shows something else (a reject that moved on to the next take) changes nothing: say so.
    else if (!result.steps.some((done) => (done.changes ?? []).length > 0))
      notPutBack.push(`${labelOf(step.ref) ?? step.ref} already reads ${JSON.stringify(step.args[0])}, so nothing changed`);
  }
  return {
    ok: notPutBack.length === 0,
    undone: taken.map((entry) => entry.said),
    ...(notPutBack.length > 0 ? { notPutBack } : {}),
  };
}

async function run(call: Call): Promise<unknown> {
  switch (call.tool) {
    case "snapshot": {
      const filter = call.filter ? words(call.filter) : "";
      // The snapshot stops at 100 controls, so a filter searches all of them first.
      const found = filter ? await agent.query({ text: call.filter }) : null;
      const shown = (Array.isArray(found) && found.length > 0 ? found : agent.snapshot()).filter(
        (component) => !filter || words(`${component.label ?? ""} ${component.row ?? ""}`).includes(filter),
      );
      // A list's rows read as all their text run together; its own item labels are what a step takes.
      return Promise.all(
        shown.map(async (component) => {
          if (!component.items?.length) return component;
          const found = await agent.query({ within: component.ref });
          const own = Array.isArray(found) ? found[0] : undefined;
          return own?.items?.length ? { ...component, items: own.items } : component;
        }),
      );
    }
    case "query":
      return agent.query({ text: call.text, within: call.within, kind: call.kind });
    case "act":
      return act(call.steps ?? [], call.card);
    case "undo":
      return undo(Math.max(1, Math.min(20, Math.floor(call.count ?? 1))));
    case "history":
      return done.map((entry) => entry.said);
  }
}

const SELECT_KINDS = ["listbox", "tabs", "select"] as const;
let selectSeq = 0;

function findCardElement(cardKey: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-lalala-card]")) {
    if (el.getAttribute("data-lalala-card") === cardKey) return el;
  }
  return null;
}

async function queryInCard(cardEl: HTMLElement, kind: string) {
  const found = await agent.query({ kind });
  if (!Array.isArray(found)) return [];
  return found.filter((component) => {
    if (component.offPage || component.disabled) return false;
    const el = elementOf(component.ref);
    return el !== null && cardEl.contains(el);
  });
}

/**
 * Selects an item inside a card through its ui-sdk controls (Listbox, Tabs, or Select): waits for
 * the card to mount and draw, clears any filled search input inside it, and applies `setValue`
 * (revealing hidden done items first if a "show done" toggle is off and the item wasn't visible).
 */
async function selectCardItem(cardKey: string, item: string): Promise<boolean> {
  const seq = ++selectSeq;
  for (let tries = 0; tries < 40; tries += 1) {
    if (seq !== selectSeq) return false;
    const cardEl = findCardElement(cardKey);
    if (cardEl && !cardEl.hasAttribute("data-lalala-card-off")) {
      const targets = [];
      for (const kind of SELECT_KINDS) {
        targets.push(...(await queryInCard(cardEl, kind)));
      }
      if (targets.length > 0) {
        if (seq !== selectSeq) return false;
        const inputs = await queryInCard(cardEl, "input");
        let clearedSearch = false;
        for (const input of inputs) {
          const el = elementOf(input.ref);
          const isSearch =
            (el instanceof HTMLInputElement && el.type === "search") ||
            /\bsearch\b/i.test(input.label ?? "");
          if (isSearch && typeof input.value === "string" && input.value !== "") {
            await agent.act({ steps: [{ ref: input.ref, action: "clear" }] });
            clearedSearch = true;
          }
        }
        if (clearedSearch) await new Promise((resolve) => setTimeout(resolve, 40));
        if (seq !== selectSeq) return false;
        for (const target of targets) {
          const result = await agent.act({
            steps: [{ ref: target.ref, action: "setValue", args: [item] }],
          });
          if (result.ok) return true;
        }
        // Item may be hidden behind an unpressed "show done" toggle: reveal it and retry once.
        const toggles = await queryInCard(cardEl, "toggle");
        const showDone = toggles.find(
          (toggle) => toggle.pressed === false && /\bshow done\b/i.test(toggle.label ?? ""),
        );
        if (showDone) {
          await agent.act({ steps: [{ ref: showDone.ref, action: "setPressed", args: [true] }] });
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (seq !== selectSeq) return false;
          for (const target of targets) {
            const retry = await agent.act({
              steps: [{ ref: target.ref, action: "setValue", args: [item] }],
            });
            if (retry.ok) return true;
          }
        }
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

declare global {
  var __lalalaSelectItem: ((cardKey: string, item: string) => Promise<boolean>) | undefined;
}
if (typeof window !== "undefined") {
  globalThis.__lalalaSelectItem = selectCardItem;
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
