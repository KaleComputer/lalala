import { Button } from "@ui-sdk/react/button";
import { useEffect, useState, useSyncExternalStore } from "react";

import { CanvasCard } from "./CanvasCard";
import { cardMark, getMarks, restoreMarked } from "./canvasStore";
import { Hidden } from "./streamer";
import "./agentMonitor.css";

type AgentStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

type AgentRunView = {
  readonly id: string;
  readonly title: string;
  readonly status: AgentStatus;
  readonly step: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly link: string | null;
  readonly card: string | null;
};

type AgentsBridge = {
  readonly get: () => ReadonlyArray<AgentRunView>;
  readonly subscribe: (listener: () => void) => () => void;
};

declare global {
  /** Live agents bridge published by src/t3/bridge.ts for extras/ without cross-bundle imports. */
  var __lalalaAgents: AgentsBridge | undefined;
}

const CARD_ID = "agent-monitor";
const PIN_KEY = "lalala:agent-monitor-pinned";
const PIN_EVENT = "lalala:agent-monitor";
const SETTINGS_KEY = "lalala:settings";
const SETTINGS_EVENT = "lalala:settings";
const EMPTY_AGENTS: ReadonlyArray<AgentRunView> = [];

type PinState = { readonly pinned: boolean; readonly canvas?: string };
const UNPINNED: PinState = { pinned: false };

function readAgentsLab(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as {
      labs?: { agentsMonitor?: unknown };
    } | null;
    return raw?.labs?.agentsMonitor === true;
  } catch {
    return false;
  }
}

let cachedLab = readAgentsLab();

function subscribeLab(listener: () => void) {
  const refresh = () => {
    cachedLab = readAgentsLab();
    listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY) refresh();
  };
  document.addEventListener(SETTINGS_EVENT, refresh);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(SETTINGS_EVENT, refresh);
    window.removeEventListener("storage", onStorage);
  };
}

function readPin(): PinState {
  if (typeof localStorage === "undefined") return UNPINNED;
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw || raw === "0" || raw === "false") return UNPINNED;
    if (raw === "1" || raw === "true") return { pinned: true };
    const parsed = JSON.parse(raw) as { pinned?: unknown; canvas?: unknown } | null;
    if (parsed && parsed.pinned === true) {
      return typeof parsed.canvas === "string" && parsed.canvas !== ""
        ? { pinned: true, canvas: parsed.canvas }
        : { pinned: true };
    }
    return UNPINNED;
  } catch {
    return UNPINNED;
  }
}

let cachedPin: PinState = readPin();

function subscribePin(listener: () => void) {
  const refresh = () => {
    cachedPin = readPin();
    listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === PIN_KEY) refresh();
  };
  document.addEventListener(PIN_EVENT, refresh);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(PIN_EVENT, refresh);
    window.removeEventListener("storage", onStorage);
  };
}

function unpinCard() {
  cachedPin = UNPINNED;
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {}
  document.dispatchEvent(new Event(PIN_EVENT));
}

function subscribeAgents(listener: () => void) {
  return globalThis.__lalalaAgents?.subscribe(listener) ?? (() => {});
}

const getAgentsSnapshot = (): ReadonlyArray<AgentRunView> =>
  globalThis.__lalalaAgents?.get() ?? EMPTY_AGENTS;

const isActive = (agent: AgentRunView) => agent.status === "running" || agent.status === "waiting";

function formatElapsed(startedAt: string, endMs: number): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(endMs)) return "0s";
  const totalSec = Math.max(0, Math.floor((endMs - start) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, "0")}m`;
}

function formatCompactMeta(agent: AgentRunView, now: number): string {
  if (agent.status === "running") return formatElapsed(agent.startedAt, now);
  if (agent.status === "waiting") return "waiting";
  if (agent.status === "failed") return "failed";
  if (agent.status === "cancelled") return "stopped";
  if (!agent.completedAt) return "done";
  const date = new Date(agent.completedAt);
  if (Number.isNaN(date.getTime())) return "done";
  const nowDate = new Date(now);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${hh}:${mm}`;
}

/**
 * Pinnable Agent Monitor card on the canvas (behind Settings -> Labs -> Agent monitor):
 * compact one-line-per-agent direct links that open each T3 thread in one click.
 */
export function AgentMonitorCard() {
  const labEnabled = useSyncExternalStore(subscribeLab, () => cachedLab, () => false);
  const pin = useSyncExternalStore(subscribePin, () => cachedPin, () => UNPINNED);

  // If the card was previously hidden via right-click Remove, re-pinning from the bar restores it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores a removed mark in canvasStore when user explicitly re-pins
  useEffect(() => {
    if (!labEnabled || !pin.pinned) return;
    const key = cardMark(CARD_ID);
    if (getMarks()[key]?.removed !== undefined) restoreMarked(key);
  }, [labEnabled, pin.pinned]);

  if (!labEnabled || !pin.pinned) return null;
  return (
    <CanvasCard
      id={CARD_ID}
      title="Agent Monitor"
      at={{ x: 48, y: 48, w: 400, h: 360 }}
      onRemove={unpinCard}
      {...(pin.canvas ? { canvas: pin.canvas } : {})}
    >
      <AgentMonitorBody />
    </CanvasCard>
  );
}

function AgentMonitorBody() {
  const agents = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, () => EMPTY_AGENTS).filter(
    (agent) => agent.title.trim() !== "" && agent.title !== "Background worker",
  );
  const [filter, setFilter] = useState<"all" | "active">("all");
  const [now, setNow] = useState(() => Date.now());

  const active = agents.filter(isActive);
  const shown = filter === "active" ? active : agents;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- live elapsed clock while at least one worker is running
  useEffect(() => {
    if (active.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active.length]);

  const summary =
    active.length > 0
      ? `${active.length} running`
      : agents.length > 0
        ? `${agents.length} recent`
        : "Idle";

  return (
    <div data-lalala-agent-card="">
      <div data-lalala-agent-card-head="">
        <span data-lalala-agent-card-summary="" data-active={active.length > 0 ? "" : undefined}>
          {summary}
        </span>
        <div data-lalala-agent-card-filters="" role="group" aria-label="Filter agents">
          <Button
            data-selected={filter === "all" ? "" : undefined}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All{agents.length > 0 ? ` ${agents.length}` : ""}
          </Button>
          <Button
            data-selected={filter === "active" ? "" : undefined}
            aria-pressed={filter === "active"}
            onClick={() => setFilter("active")}
          >
            Active{active.length > 0 ? ` ${active.length}` : ""}
          </Button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p data-lalala-agent-card-empty="">
          {filter === "active"
            ? "No agents running right now."
            : "No agent runs yet. Threads appear here automatically."}
        </p>
      ) : (
        <ol data-lalala-agent-card-list="">
          {shown.map((agent) => {
            const running = isActive(agent);
            const compactMeta = formatCompactMeta(agent, now);
            const rowContent = (
              <>
                <span data-lalala-agent-card-title="">
                  <Hidden text={agent.title} />
                </span>
                <time
                  data-lalala-agent-card-time=""
                  dateTime={running ? agent.startedAt : (agent.completedAt ?? agent.updatedAt)}
                >
                  {compactMeta}
                </time>
              </>
            );
            return (
              <li key={agent.id} data-lalala-agent-card-item="" data-status={agent.status}>
                {agent.link ? (
                  <a
                    data-lalala-agent-card-row=""
                    href={agent.link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {rowContent}
                  </a>
                ) : (
                  <div data-lalala-agent-card-row="" data-inert="">
                    {rowContent}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
