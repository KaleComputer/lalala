import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";

import { StreamerText } from "../streamerMode";
import { type InboxItem, unreadItems } from "./capture";
import { markInbox, useAwayInbox, useInbox } from "./store";
import "./inbox.css";

type Filter = "unread" | "all";

const time = (at: string) => {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * The away inbox (Labs): the bar's tab with the unread count, and its panel "While you were away".
 * Every control is named `inbox: …`, so the brain finds it through the canvas's ui bridge.
 */
export function InboxTab(props: { readonly tabHost: HTMLElement }) {
  const on = useAwayInbox();
  const inbox = useInbox();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("unread");
  if (!on) return null;
  const unread = unreadItems(inbox).length;
  const shown = (filter === "unread" ? unreadItems(inbox) : inbox.items).toReversed();
  return (
    <Dialog open={open} modal={false} closeOnOutsidePress onOpenChange={setOpen}>
      {createPortal(
        <Button
          data-lalala-inbox-tab=""
          data-lalala-tab=""
          data-open={open ? "" : undefined}
          aria-expanded={open}
          aria-label={unread > 0 ? `inbox: open, ${unread} unread` : "inbox: open"}
          title={unread > 0 ? `While you were away · ${unread} unread` : "While you were away"}
          onClick={() => setOpen(!open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
          {unread > 0 ? <b data-lalala-inbox-count="">{unread > 99 ? "99+" : unread}</b> : null}
        </Button>,
        props.tabHost,
      )}
      {open
        ? createPortal(
            <div data-lalala-inbox="">
              <DialogContent data-lalala-inbox-panel="">
                <header>
                  <DialogTitle>While you were away</DialogTitle>
                  <DialogClose aria-label="inbox: close">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </DialogClose>
                </header>
                <div data-lalala-inbox-tools="">
                  <SegmentedControl
                    value={filter}
                    onValueChange={(value) => setFilter(value as Filter)}
                    aria-label="inbox: filter"
                  >
                    <SegmentedControlItem value="unread" aria-label="inbox: show unread">
                      Unread{unread > 0 ? ` ${unread}` : ""}
                    </SegmentedControlItem>
                    <SegmentedControlItem value="all" aria-label="inbox: show all">
                      All
                    </SegmentedControlItem>
                  </SegmentedControl>
                  <Button
                    data-lalala-inbox-action=""
                    aria-label="inbox: mark all heard"
                    disabled={unread === 0}
                    onClick={() => markInbox({ heard: "all" })}
                  >
                    Mark all heard
                  </Button>
                </div>
                {shown.length === 0 ? (
                  <p data-lalala-inbox-empty="">
                    {filter === "unread"
                      ? "Nothing waiting. Results from your threads land here while you're not in a call."
                      : "Nothing yet. Results from your threads land here while you're not in a call."}
                  </p>
                ) : (
                  <ol data-lalala-inbox-list="">
                    {shown.map((item) => (
                      <Entry key={item.source} item={item} onCard={() => setOpen(false)} />
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

function Entry(props: { readonly item: InboxItem; readonly onCard: () => void }) {
  const { item } = props;
  const card = item.card;
  return (
    <li data-lalala-inbox-item="" data-heard={item.heard ? "" : undefined}>
      <div data-lalala-inbox-meta="">
        <time dateTime={item.at}>{time(item.at)}</time>
        <span>
          <StreamerText text={item.from} />
        </span>
        {item.outcome === "failed" || item.outcome === "cancelled" ? (
          <em data-lalala-inbox-outcome="">{item.outcome}</em>
        ) : null}
      </div>
      <p>
        <StreamerText text={item.summary} />
      </p>
      <div data-lalala-inbox-actions="">
        <Button
          data-lalala-inbox-action=""
          aria-label={`inbox: mark ${item.heard ? "unread" : "heard"} ${item.id}`}
          onClick={() => markInbox(item.heard ? { unheard: [item.id] } : { heard: [item.id] })}
        >
          {item.heard ? "Mark unread" : "Mark heard"}
        </Button>
        {card ? (
          <Button
            data-lalala-inbox-action=""
            aria-label={`inbox: open card ${card}`}
            onClick={() => {
              globalThis.__lalalaCanvases?.focus?.(card);
              props.onCard();
            }}
          >
            Show card
          </Button>
        ) : null}
        {item.link ? (
          <a data-lalala-inbox-action="" href={item.link} target="_blank" rel="noreferrer">
            Open thread
          </a>
        ) : null}
      </div>
    </li>
  );
}
