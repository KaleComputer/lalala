import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";

import { useAgents } from "../../state/entities";
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

/**
 * Live Agent Progress & Monitor in the device bar (matching InboxTab): shows the running delegate
 * count badge, opens a compact live monitor with current tool/step, elapsed time, exact completion
 * timestamps (`done at HH:MM`), and lets the user pin the Agent Monitor card onto the canvas.
 */
export function AgentsTab(props: { readonly tabHost: HTMLElement }) {
  const agents = useAgents();
  const pin = useAgentMonitorPin();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());

  const active = agents.filter(isActiveAgent);
  const activeCount = active.length;
  const waitingCount = active.filter((agent) => agent.status === "waiting").length;
  const shown = filter === "active" ? active : agents;

  // Tick elapsed timers once per second only while the panel is open and an agent is running.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- live elapsed clock while the popover is open
  useEffect(() => {
    if (!open || activeCount === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, activeCount]);

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

  const singleStep = activeCount === 1 && active[0]?.step ? ` — ${active[0].step}` : "";
  const title =
    activeCount > 0
      ? `Agents · ${activeCount} running${singleStep}`
      : agents.length > 0
        ? `Agents · ${agents.length} recent`
        : "Agent Monitor";

  return (
    <Dialog open={open} modal={false} closeOnOutsidePress onOpenChange={setOpen}>
      {createPortal(
        <Button
          data-lalala-agents-tab=""
          data-lalala-tab=""
          data-open={open ? "" : undefined}
          data-active={activeCount > 0 ? "" : undefined}
          data-waiting={waitingCount > 0 ? "" : undefined}
          aria-expanded={open}
          aria-label={activeCount > 0 ? `agents: open, ${activeCount} running` : "agents: open"}
          title={title}
          onClick={() => setOpen(!open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h3l2.5-6 4 12 2.5-6H20" />
          </svg>
          {activeCount > 0 ? (
            <>
              <i data-lalala-agents-dot="" aria-hidden="true" />
              <b data-lalala-agents-count="">{activeCount > 99 ? "99+" : activeCount}</b>
            </>
          ) : null}
        </Button>,
        props.tabHost,
      )}
      {open
        ? createPortal(
            <div data-lalala-agents="">
              <DialogContent data-lalala-agents-panel="">
                <header>
                  <DialogTitle>
                    <span>Agents</span>
                    {activeCount > 0 ? (
                      <span data-lalala-agents-pill="">{activeCount} running</span>
                    ) : null}
                  </DialogTitle>
                  <Button
                    data-lalala-agents-action=""
                    data-pinned={pin.pinned ? "" : undefined}
                    aria-label={pin.pinned ? "agents: unpin card" : "agents: pin card"}
                    onClick={togglePin}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1h1V3H7v2h1a1 1 0 0 1 1 1z" />
                    </svg>
                    {pin.pinned ? "Pinned" : "Pin card"}
                  </Button>
                  <DialogClose data-lalala-agents-close="" aria-label="agents: close">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </DialogClose>
                </header>
                <div data-lalala-agents-tools="">
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
                {shown.length === 0 ? (
                  <p data-lalala-agents-empty="">
                    {filter === "active"
                      ? "No agents running right now."
                      : "No agent runs yet. Background workers appear here with live progress and completion times."}
                  </p>
                ) : (
                  <ol data-lalala-agents-list="">
                    {shown.map((agent) => (
                      <AgentEntry
                        key={agent.id}
                        agent={agent}
                        now={now}
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
  readonly onClose: () => void;
}) {
  const { agent, now } = props;
  const active = isActiveAgent(agent);
  const duration = active ? null : formatDuration(agent.startedAt, agent.completedAt);
  const timeText = active
    ? formatElapsed(agent.startedAt, now)
    : `${formatDoneAt(agent.completedAt, new Date(now))}${duration ? ` · ${duration}` : ""}`;
  const stepText =
    agent.step ??
    (agent.status === "waiting"
      ? "Waiting for input…"
      : agent.status === "running"
        ? "Working…"
        : agent.status === "failed"
          ? "Failed"
          : agent.status === "cancelled"
            ? "Cancelled"
            : null);

  return (
    <li data-lalala-agents-item="" data-status={agent.status}>
      <div data-lalala-agents-row="">
        <i data-lalala-agents-status-dot="" aria-hidden="true" />
        <span data-lalala-agents-title="">
          <StreamerText text={agent.title} />
        </span>
        <time
          data-lalala-agents-time=""
          dateTime={active ? agent.startedAt : (agent.completedAt ?? agent.updatedAt)}
        >
          {timeText}
        </time>
      </div>
      {stepText ? (
        <p data-lalala-agents-step="">
          <StreamerText text={stepText} />
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
    </li>
  );
}
