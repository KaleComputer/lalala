import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { StreamerText, useStreamerMode } from "./streamerMode";

/** A phone or tablet: never the computer T3 Code runs on. */
export function isPhone() {
  const nav = navigator as Navigator & { userAgentData?: { readonly mobile: boolean } };
  // iPadOS Safari calls itself a Mac.
  const touchMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  return nav.userAgentData?.mobile ?? (touchMac || /iPhone|iPad|iPod|Android|Mobile/.test(navigator.userAgent));
}

const untilDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

const hostOf = (origin: string) => origin.replace(/^\w+:\/\//, "");

/**
 * Not connected yet: one field for whatever T3 Code's Create link gave (the link, its code, or the
 * whole copied text), and everything after that runs by itself (`onPair`). Only when this device
 * can't reach the address in it (`ask`) does it ask for the one thing missing: the T3 Connect address.
 */
export function PairSteps(props: {
  readonly command: string;
  readonly working: string | null;
  readonly problem: string | null;
  readonly onPair: (input: string) => void;
  /** lalala.talk: this device couldn't reach the pasted link's local address; asks for the T3 Connect address (the remembered one first). */
  readonly ask?: {
    readonly address: string;
    readonly onAddress: (value: string) => void;
    readonly onBack: () => void;
  } | null;
  /** The address it is pairing with, shown while it works. */
  readonly target?: string | null | undefined;
  /** Another way to pair, under the field (the app: the T3 Code on this computer). */
  readonly children?: ReactNode;
}) {
  const ask = props.ask ?? null;
  const [link, setLink] = useState("");
  // Starts as the remembered address, once asked.
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const streamer = useStreamerMode();
  const busy = props.working !== null;
  const submit = (input: string) => {
    const value = input.trim();
    if (value === "" || busy) return;
    if (ask) ask.onAddress(value);
    else props.onPair(value);
  };
  const value = ask ? (address ?? ask.address) : link;
  const setValue = ask ? setAddress : setLink;

  return (
    <>
      <div data-lalala-settings-row="" data-lalala-pair="">
        <div>
          <h3>T3 Code</h3>
          <p>
            {ask ? (
              `${isPhone() ? "Your phone" : "This browser"} can't reach T3 Code's local address. Paste your T3 Connect address instead: T3 Code → Settings → Environments → ⋯ → Copy MCP URL.`
            ) : (
              "T3 Code → Settings → Sharing & access → Create link, then paste the link or code here."
            )}
          </p>
        </div>
        <div data-lalala-settings-control="">
          <span aria-live="polite" data-lalala-settings-status="">
            Not connected
          </span>
        </div>
        <div data-lalala-pair-field="">
          <input
            key={ask ? "address" : "link"}
            type={ask ? "url" : "text"}
            inputMode={ask ? "url" : undefined}
            aria-label={ask ? "Your T3 Connect address" : "Pairing link or code"}
            placeholder={ask ? "https://….t3coderelay.com/mcp" : "Paste link or code"}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field to fill once the address is asked for
            autoFocus={ask !== null}
            data-streamer-input={streamer ? "" : undefined}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.currentTarget.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text").trim();
              if (pasted === "") return;
              event.preventDefault();
              setValue(pasted);
              submit(pasted);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(value);
              if (event.key === "Escape" && ask) {
                event.preventDefault();
                event.stopPropagation();
                ask.onBack();
              }
            }}
          />
        </div>
        {ask ? (
          <p data-lalala-pair-alt="">
            <button type="button" data-lalala-settings-button="" data-quiet="" disabled={busy} onClick={ask.onBack}>
              Back
            </button>
          </p>
        ) : (
          <p data-lalala-pair-alt="">
            Or run <code>{props.command}</code>
            <button
              type="button"
              data-lalala-settings-button=""
              data-quiet=""
              onClick={() => void navigator.clipboard.writeText(props.command).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
        )}
      </div>
      {props.working ? (
        <p data-lalala-settings-info="" role="status">
          {props.working}
          {props.target ? (
            <>
              {" · "}
              <StreamerText text={hostOf(props.target)} />
            </>
          ) : null}
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
