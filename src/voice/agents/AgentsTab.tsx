import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";

import { useAgents } from "../../state/entities";
import { useSyncedSettings } from "../settingsStore";
import { StreamerText } from "../streamerMode";
import {
  type AgentRun,
  formatDoneAt,
  formatDuration,
  formatElapsed,
  isActiveAgent,
} from "./model";
import { AGENT_MONITOR_CARD_ID, setAgentMonitorPinned, useAgentMonitorPin } from "./pin";
import "./agents.css";

type Filter = "all" | "active";

/** Compact right-side status/clock text for the single-line row (fixed width, no layout shift). */
function compactAgentMeta(agent: AgentRun, now: number): string {
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
 * Live Agent Progress & Monitor in the device bar: shows icon + running count (no dot), opens a
 * compact one-line-per-agent list with click-to-expand details and Open thread in T3 Code.
 */
export function AgentsTab(props: { readonly tabHost: HTMLElement }) {
  const enabled = useSyncedSettings().labs.agentsMonitor;
  const agents = useAgents();
  const pin = useAgentMonitorPin();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState<{ readonly left: number; readonly bottom: number } | null>(
    null,
  );
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = agents.filter(isActiveAgent);
  const activeCount = active.length;
  const waitingCount = active.filter((agent) => agent.status === "waiting").length;
  const shown = filter === "active" ? active : agents;

  // Tick elapsed timers once per second only while the panel is open and an agent is running.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- live elapsed clock while the popover is open
  useEffect(() => {
    if (!enabled || !open || activeCount === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled, open, activeCount]);

  // Anchor the popover cleanly above the Agents button, clamped inside the viewport.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures button screen rect so the popover rises above the tab
  useLayoutEffect(() => {
    if (!enabled || !open) return;
    const place = () => {
      const btn = tabRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panelW = Math.min(400, Math.max(260, vw - 24));
      const left = Math.round(Math.max(12, Math.min(rect.left, vw - panelW - 12)));
      const bottom = Math.round(Math.max(76, vh - rect.top + 10));
      setAnchor({ left, bottom });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [enabled, open]);

  // Close on outside click or when another bar panel opens — ignoring the Agents tab itself so
  // clicking the tab while open toggles cleanly instead of closing on pointerdown and re-opening on click.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coordinates popover dismissal with outside clicks and other bar panels
  useEffect(() => {
    if (!enabled || !open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || tabRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onPanel = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "agents") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("lalala:panel", onPanel);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("lalala:panel", onPanel);
    };
  }, [enabled, open]);

  if (!enabled) return null;

  const toggleOpen = () => {
    setOpen((was) => {
      const next = !was;
      if (next) {
        document.dispatchEvent(new CustomEvent("lalala:panel", { detail: "agents" }));
      }
      return next;
    });
  };

  const togglePin = () => {
    if (pin.pinned) {
      setAgentMonitorPinned(false);
      return;
    }
    const currentCanvas = globalThis.__lalalaCanvases?.snapshot().active;
    setAgentMonitorPinned(true, currentCanvas || undefined);
    setOpen(false);
    window.requestAnimationFrame(() => {
      globalThis.__lalalaCanvases?.focus?.(AGENT_MONITOR_CARD_ID);
    });
  };

  const title =
    activeCount > 0
      ? `Agents · ${activeCount} running`
      : agents.length > 0
        ? `Agents · ${agents.length} recent`
        : "Agent Monitor";

  const panelStyle: CSSProperties | undefined = anchor
    ? { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }
    : undefined;

  return (
    <Dialog open={open} modal={false} closeOnOutsidePress={false} onOpenChange={setOpen}>
      {createPortal(
        <Button
          ref={tabRef}
          data-lalala-agents-tab=""
          data-lalala-tab=""
          data-open={open ? "" : undefined}
          data-active={activeCount > 0 ? "" : undefined}
          data-waiting={waitingCount > 0 ? "" : undefined}
          aria-expanded={open}
          aria-label={activeCount > 0 ? `agents: open, ${activeCount} running` : "agents: open"}
          title={title}
          onClick={toggleOpen}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h3l2.5-6 4 12 2.5-6H20" />
          </svg>
          {activeCount > 0 ? (
            <b data-lalala-agents-count="">{activeCount > 99 ? "99+" : activeCount}</b>
          ) : null}
        </Button>,
        props.tabHost,
      )}
      {open
        ? createPortal(
            <div data-lalala-agents="">
              <DialogContent
                ref={panelRef}
                data-lalala-agents-panel=""
                style={panelStyle}
              >
                <header>
                  <DialogTitle>
                    <span>Agents</span>
                    {activeCount > 0 ? (
                      <span data-lalala-agents-pill="">{activeCount} running</span>
                    ) : null}
                  </DialogTitle>
                  <div data-lalala-agents-filter="">
                    <SegmentedControl
                      value={filter}
                      onValueChange={(value) => setFilter(value as Filter)}
                      aria-label="agents: filter"
                    >
                      <SegmentedControlItem value="all" aria-label="agents: show all">
                        All{agents.length > 0 ? ` ${agents.length}` : ""}
                      </SegmentedControlItem>
                      <SegmentedControlItem value="active" aria-label="agents: show active">
                        Active{activeCount > 0 ? ` ${activeCount}` : ""}
                      </SegmentedControlItem>
                    </SegmentedControl>
                  </div>
                  <Button
                    data-lalala-agents-icon=""
                    data-pinned={pin.pinned ? "" : undefined}
                    aria-label={pin.pinned ? "agents: unpin card" : "agents: pin card"}
                    title={pin.pinned ? "Unpin Agent Monitor card" : "Pin Agent Monitor card to canvas"}
                    onClick={togglePin}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1h1V3H7v2h1a1 1 0 0 1 1 1z" />
                    </svg>
                  </Button>
                  <DialogClose data-lalala-agents-close="" aria-label="agents: close">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </DialogClose>
                </header>
                {shown.length === 0 ? (
                  <p data-lalala-agents-empty="">
                    {filter === "active"
                      ? "No agents running right now."
                      : "No agent runs yet. Background workers appear here automatically."}
                  </p>
                ) : (
                  <ol data-lalala-agents-list="">
                    {shown.map((agent) => (
                      <AgentEntry
                        key={agent.id}
                        agent={agent}
                        now={now}
                        expanded={expandedId === agent.id}
                        onToggle={() =>
                          setExpandedId((current) => (current === agent.id ? null : agent.id))
                        }
                        onClose={() => setOpen(false)}
                      />
                    ))}
                  </ol>
                )}
              </DialogContent>
            </div>,
            props.tabHost.ownerDocument.body,
          )
        : null}
    </Dialog>
  );
}

function AgentEntry(props: {
  readonly agent: AgentRun;
  readonly now: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
}) {
  const { agent, now, expanded, onToggle } = props;
  const active = isActiveAgent(agent);
  const compactMeta = compactAgentMeta(agent, now);
  const duration = active ? null : formatDuration(agent.startedAt, agent.completedAt);
  const timingDetail = active
    ? `Running for ${formatElapsed(agent.startedAt, now)}`
    : `${formatDoneAt(agent.completedAt, new Date(now))}${duration ? ` · ${duration}` : ""}`;
  const statusLabel =
    agent.status === "running"
      ? "Running"
      : agent.status === "waiting"
        ? "Waiting"
        : agent.status === "failed"
          ? "Failed"
          : agent.status === "cancelled"
            ? "Stopped"
            : "Completed";

  return (
    <li
      data-lalala-agents-item=""
      data-status={agent.status}
      data-expanded={expanded ? "" : undefined}
    >
      <button
        type="button"
        data-lalala-agents-row=""
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span data-lalala-agents-title="">
          <StreamerText text={agent.title} />
        </span>
        <time
          data-lalala-agents-time=""
          dateTime={active ? agent.startedAt : (agent.completedAt ?? agent.updatedAt)}
        >
          {compactMeta}
        </time>
        <svg data-lalala-agents-chevron="" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {expanded ? (
        <div data-lalala-agents-details="">
          <div data-lalala-agents-detail-meta="">
            <span>{statusLabel}</span>
            <span>·</span>
            <span>{timingDetail}</span>
          </div>
          {agent.step ? (
            <p data-lalala-agents-step="">
              <StreamerText text={agent.step} />
            </p>
          ) : null}
          {agent.card || agent.link ? (
            <div data-lalala-agents-actions="">
              {agent.card ? (
                <Button
                  data-lalala-agents-action=""
                  aria-label={`agents: show card ${agent.card}`}
                  onClick={() => {
                    globalThis.__lalalaCanvases?.focus?.(agent.card!);
                    props.onClose();
                  }}
                >
                  Show card
                </Button>
              ) : null}
              {agent.link ? (
                <a data-lalala-agents-action="" href={agent.link} target="_blank" rel="noreferrer">
                  Open thread
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
