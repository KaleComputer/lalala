import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { StreamerText, useStreamerMode } from "./streamerMode";

/**
 * Where T3 Code is reached from: the app's own server (any browser works), or this tab itself
 * (lalala.talk), which needs a browser that may reach the computer's local network.
 */
export type Reach = "server" | "tab";

const SUPPORTED =
  "Works in Chrome and Edge on the computer running T3 Code; anywhere else through your T3 Connect address.";
const CONNECT_ADDRESS = "https://….t3coderelay.com";

/** Whether this browser can reach T3 Code, in one line the settings show as is. */
export function browserSupport(reach: Reach): { readonly ok: boolean; readonly line: string } {
  if (reach === "server") return { ok: true, line: "Works in any browser: the app's server talks to T3 Code." };
  const nav = navigator as Navigator & {
    userAgentData?: { readonly mobile: boolean; readonly brands: ReadonlyArray<{ brand: string }> };
  };
  const ua = navigator.userAgent;
  // iPadOS Safari calls itself a Mac.
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const phone = nav.userAgentData?.mobile ?? (touchMac || /iPhone|iPad|iPod|Android|Mobile/.test(ua));
  const chromium = nav.userAgentData?.brands.some((b) => b.brand === "Chromium") ?? false;
  if (chromium && !phone) return { ok: true, line: SUPPORTED };
  const name = phone
    ? "A phone or tablet browser"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Safari\//.test(ua)
        ? "Safari"
        : "This browser";
  return {
    ok: false,
    line: `${name} can't reach T3 Code on your computer directly: add your T3 Connect address, or paste an https pairing link (Tailscale, NetBird).`,
  };
}

const PAIR_WAYS = ["app", "terminal"] as const;

const untilDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function Step(props: {
  readonly n: number;
  readonly title: string;
  readonly description?: ReactNode;
  readonly state?: "done" | "now" | undefined;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div data-lalala-settings-row="" data-lalala-settings-step={props.state ?? ""}>
      <div>
        <h3>
          <span data-lalala-settings-step-n="" aria-hidden="true">
            {props.state === "done" ? "✓" : props.n}
          </span>
          {props.title}
        </h3>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.control ? <div data-lalala-settings-control="">{props.control}</div> : null}
      {props.children}
    </div>
  );
}

/**
 * Not connected yet: make a pairing link in T3 Code (or with the terminal), paste it, and everything
 * after that runs by itself (`onPair`), saying what it does in `working` and what to fix in `problem`.
 */
export function PairSteps(props: {
  readonly reach: Reach;
  /** The name the pairing gets in T3 Code. */
  readonly label: string;
  readonly command: string;
  readonly working: string | null;
  readonly problem: string | null;
  readonly onPair: (input: string) => void;
  /** lalala.talk: the T3 Connect address to pair through instead of a link's local one, remembered by the caller. */
  readonly address?: { readonly value: string; readonly onChange: (value: string) => void } | undefined;
  /** The address it is pairing with, shown while it works. */
  readonly target?: string | null | undefined;
  /** Another way to pair, under the steps (the app: the T3 Code on this computer). */
  readonly children?: ReactNode;
}) {
  const [way, setWay] = useState<"app" | "terminal">("app");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const support = browserSupport(props.reach);
  const streamer = useStreamerMode();
  const busy = props.working !== null;
  const pair = (input: string) => {
    const value = input.trim();
    if (value !== "" && !busy) props.onPair(value);
  };
  const address = props.address;
  // A browser that can't reach a local T3 still pairs through a T3 Connect address.
  const usable = support.ok || address !== undefined;
  const needsAddress = !support.ok && address !== undefined && address.value.trim() === "";
  let n = 1;

  return (
    <>
      <div data-lalala-settings-row="">
        <div>
          <h3>T3 Code</h3>
          <p>
            {support.ok
              ? support.line
              : address
                ? "Works here through your T3 Connect address."
                : "Not available in this browser."}
          </p>
        </div>
        <div data-lalala-settings-control="">
          <span aria-live="polite" data-lalala-settings-status="">
            Not connected
          </span>
        </div>
      </div>
      {usable ? null : (
        <p data-lalala-settings-error="" role="alert">
          {support.line}
        </p>
      )}
      <Step
        n={n++}
        title="Make a pairing link"
        state={busy ? "done" : undefined}
        control={
          <div
            role="radiogroup"
            aria-label="Where to make it"
            data-lalala-settings-segments=""
            onKeyDown={(event) => {
              const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
              if (delta === undefined) return;
              event.preventDefault();
              const index = (PAIR_WAYS.indexOf(way) + delta + PAIR_WAYS.length) % PAIR_WAYS.length;
              setWay(PAIR_WAYS[index]!);
              const radios =
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
              radios[index]?.focus();
            }}
          >
            {PAIR_WAYS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={way === option}
                tabIndex={way === option ? 0 : -1}
                onClick={() => setWay(option)}
              >
                {option === "app" ? "In T3 Code" : "Terminal"}
              </button>
            ))}
          </div>
        }
      >
        {way === "app" ? (
          <ol data-lalala-settings-how="">
            <li>
              <p>Open Settings → Sharing &amp; access and click Create link.</p>
            </li>
            <li>
              <p>
                Name it {props.label}, keep View environment and Operate tasks ticked, then click Create
                link.
              </p>
            </li>
            <li>
              <p>Click Copy link. Where T3 Code shows only Copy code, copy that.</p>
            </li>
          </ol>
        ) : (
          <div data-lalala-settings-command="">
            <code data-lalala-settings-code="">
              {props.command.split(/(--[\w-]+)/).map((part, index) =>
                // oxlint-disable-next-line react/no-array-index-key -- command tokens have fixed order and no state
                part.startsWith("--") ? <span key={index}>{part}</span> : part,
              )}
            </code>
            <button
              type="button"
              data-lalala-settings-button=""
              onClick={() => void navigator.clipboard.writeText(props.command).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </Step>
      {address ? (
        <Step
          n={n++}
          title="Your T3 address"
          description={
            support.ok
              ? `Away from the computer running T3 Code? Your T3 Connect address (${CONNECT_ADDRESS}). Leave it empty on that computer.`
              : `Your T3 Connect address (${CONNECT_ADDRESS}): this browser reaches T3 Code through it, from anywhere. Asked once.`
          }
          state={busy ? "done" : needsAddress ? "now" : undefined}
          control={
            <input
              type="url"
              inputMode="url"
              aria-label="Your T3 Connect address"
              placeholder={CONNECT_ADDRESS}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-streamer-input={streamer ? "" : undefined}
              value={address.value}
              disabled={busy}
              onChange={(event) => address.onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") pair(link);
              }}
            />
          }
        />
      ) : null}
      <Step
        n={n++}
        title="Paste it here"
        description="The link or code. It connects on its own."
        state={busy ? "done" : needsAddress ? undefined : "now"}
        control={
          <input
            type="text"
            aria-label="Pairing link or code"
            placeholder="Paste link or code"
            autoComplete="off"
            spellCheck={false}
            data-streamer-input={streamer ? "" : undefined}
            value={link}
            disabled={busy}
            onChange={(event) => setLink(event.currentTarget.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text").trim();
              if (pasted === "") return;
              event.preventDefault();
              setLink(pasted);
              pair(pasted);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") pair(link);
            }}
          />
        }
      />
      {props.reach === "tab" && support.ok && !address?.value.trim() ? (
        <Step
          n={n++}
          title="Allow the local network"
          description="Chrome asks once to let this page reach your computer: click Allow. Blocked it before? Click the icon left of the address bar, open Site settings, set Local network access to Allow."
          state={busy ? "now" : undefined}
        />
      ) : null}
      {props.working ? (
        <p data-lalala-settings-info="" role="status">
          {props.working}
        </p>
      ) : null}
      {busy && props.target ? (
        <p data-lalala-settings-info="">
          T3 Code at <StreamerText text={props.target} />
        </p>
      ) : null}
      {props.problem ? (
        <p data-lalala-settings-error="" role="alert">
          <StreamerText text={props.problem} />
        </p>
      ) : null}
      {props.children}
    </>
  );
}

/**
 * Connected: the server and when it last answered (`checked`), what `children` add (the thread), how
 * long the pairing lasts, Retest and Disconnect.
 */
export function ConnectedRows(props: {
  readonly ok: boolean;
  readonly where: string;
  readonly checked: string | null;
  readonly problem: string | null;
  readonly expiresAt: number | null;
  readonly renews?: boolean | undefined;
  readonly busy: boolean;
  readonly onRetest: () => void;
  readonly onDisconnect: () => void;
  readonly children?: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a fresh pairing swaps the taller steps for these rows; keeps Connected in view (DOM scroll)
  useEffect(() => {
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const [confirming, setConfirming] = useState(false);
  const consequenceId = useId();
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus the inline confirmation's safe action when it appears
  useLayoutEffect(() => {
    if (confirming) cancelRef.current?.focus({ preventScroll: true });
  }, [confirming]);
  const cancel = () => {
    setConfirming(false);
    disconnectRef.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <div data-lalala-settings-row="" ref={rowRef}>
        <div>
          <h3>T3 Code</h3>
          {props.where ? (
            <p>
              <StreamerText text={props.where} />
            </p>
          ) : null}
          <div aria-live="polite">
            {props.problem || props.checked ? (
              <p data-lalala-settings-error={props.problem ? "" : undefined}>
                {props.problem ? <StreamerText text={props.problem} /> : props.checked}
              </p>
            ) : null}
          </div>
        </div>
        <div data-lalala-settings-control="">
          <span
            aria-live="polite"
            data-lalala-settings-status=""
            data-ok={props.ok ? "" : undefined}
          >
            {props.ok ? "Connected" : "Not connected"}
          </span>
          <button
            type="button"
            data-lalala-settings-button=""
            data-quiet=""
            disabled={props.busy}
            onClick={props.onRetest}
          >
            Retest
          </button>
        </div>
      </div>
      {props.children}
      <div
        data-lalala-settings-row=""
        data-lalala-settings-pairing=""
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setConfirming(false);
        }}
        onKeyDown={(event) => {
          if (confirming && event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <div>
          <h3>Pairing</h3>
          <div data-lalala-settings-pairing-copy="">
            <p data-inactive={confirming || undefined}>
              {props.expiresAt === null ? (
                "Forget it to pair again."
              ) : (
                <>
                  Valid until <StreamerText text={untilDate(props.expiresAt)} />.{" "}
                  {props.renews ? "Renews itself a week before." : "Pair again after that."}
                </>
              )}
            </p>
            <p id={consequenceId} data-inactive={!confirming || undefined}>
              Disconnect? The voice stops until you pair again.
            </p>
          </div>
        </div>
        <div data-lalala-settings-control="">
          <button
            ref={disconnectRef}
            type="button"
            aria-describedby={confirming ? consequenceId : undefined}
            data-lalala-settings-button=""
            data-quiet=""
            data-danger=""
            disabled={props.busy}
            onMouseDown={(event) => confirming && event.preventDefault()}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              setConfirming(false);
              props.onDisconnect();
            }}
          >
            Disconnect
          </button>
          {confirming ? (
            <button
              ref={cancelRef}
              type="button"
              aria-describedby={consequenceId}
              data-lalala-settings-button=""
              data-quiet=""
              onMouseDown={(event) => event.preventDefault()}
              onClick={cancel}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
