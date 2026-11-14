import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { StreamerText, useStreamerMode } from "./streamerMode";

/** A phone or tablet: never the computer T3 Code runs on. */
export function isPhone() {
  const nav = navigator as Navigator & { userAgentData?: { readonly mobile: boolean } };
  // iPadOS Safari calls itself a Mac.
  const touchMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  // Any sign counts: an Android tablet's userAgentData says mobile: false, its user agent says Android.
  return (
    nav.userAgentData?.mobile === true ||
    touchMac ||
    /iPhone|iPad|iPod|Android|Mobile/.test(navigator.userAgent)
  );
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
  /** Pairs from anywhere: makes a link on the T3 Connect address, so a phone can use it too. */
  readonly connectCommand?: string | undefined;
  readonly working: string | null;
  readonly problem: string | null;
  /** `via`: the T3 Connect address typed on the "Another computer" path, to pair through. */
  readonly onPair: (input: string, via?: string) => void;
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
  const choiceId = useId();
  const [link, setLink] = useState("");
  // Starts as the remembered address, once asked.
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(text);
        window.setTimeout(() => setCopied((now) => (now === text ? null : now)), 2000);
      },
      () => setCopied(null),
    );
  const streamer = useStreamerMode();
  const busy = props.working !== null;
  const submit = (input: string) => {
    const value = input.trim();
    if (value === "" || busy) return;
    if (ask) ask.onAddress(value);
    else props.onPair(value, path === "other" && connectAddress.trim() !== "" ? connectAddress.trim() : undefined);
  };
  const value = ask ? (address ?? ask.address) : link;
  const setValue = ask ? setAddress : setLink;
  // lalala.talk offers two ways in; a phone is never the computer T3 Code runs on.
  const remote = props.connectCommand !== undefined;
  const [where, setWhere] = useState<Where>(() => (isPhone() ? "other" : readWhere()));
  const path: Where = remote && !isPhone() ? where : remote ? "other" : "here";
  const [connectAddress, setConnectAddress] = useState("");
  const host = connectAddress
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/(mcp)?\/?$/i, "");
  // Only a real host fills the command: the placeholder would be a shell redirect.
  const connectCommand =
    props.connectCommand && /^[a-z0-9.-]+(:\d+)?$/i.test(host)
      ? props.connectCommand.replace("<your T3 Connect address>", host)
      : null;
  const phone = isPhone();

  const field = (placeholder: string, label: string) => (
    <div data-lalala-pair-field="" data-failed={props.problem ? "" : undefined}>
      <input
        key={ask ? "address" : "link"}
        type={ask ? "url" : "text"}
        inputMode={ask ? "url" : undefined}
        aria-label={ask ? "Your T3 Connect address" : label}
        aria-invalid={props.problem ? true : undefined}
        aria-describedby={props.problem ? `${choiceId}e` : undefined}
        placeholder={ask ? "https://….t3coderelay.com/mcp" : placeholder}
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
  );
  const command = (text: string | null, missing?: string) => (
    <p data-lalala-pair-command="" data-missing={text === null ? "" : undefined}>
      <code aria-live="polite">{text ?? missing}</code>
      <button
        type="button"
        data-lalala-settings-button=""
        data-quiet=""
        disabled={text === null}
        onClick={() => text !== null && copy(text)}
      >
        {text !== null && copied === text ? "Copied" : "Copy"}
      </button>
    </p>
  );
  const status = (
    <span aria-live="polite" data-lalala-settings-status="">
      Not connected
    </span>
  );
  const choosing = remote && !phone && !ask;

  return (
    <>
      {choosing ? (
        <div data-lalala-settings-row="" data-lalala-pair="">
          <div>
            <h3 id={`${choiceId}t`}>Where does T3 Code run?</h3>
          </div>
          <div data-lalala-settings-control="">{status}</div>
          <div
            role="radiogroup"
            aria-labelledby={`${choiceId}t`}
            data-lalala-pair-choice=""
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
                return;
              event.preventDefault();
              const next: Where =
                event.key === "Home" ? "here" : event.key === "End" ? "other" : path === "here" ? "other" : "here";
              pick(next);
              event.currentTarget.querySelector<HTMLElement>(`[data-where="${next}"]`)?.focus();
            }}
          >
            {WHERES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={path === option.id}
                tabIndex={path === option.id ? 0 : -1}
                data-where={option.id}
                onClick={() => pick(option.id)}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div data-lalala-settings-row="" data-lalala-pair="">
          <div>
            <div data-lalala-pair-title="">
              <h3>T3 Code</h3>
              {status}
            </div>
            <p>
              {ask
                ? `${phone ? "Your phone" : "This browser"} can't reach T3 Code's local address. Paste your T3 Connect address instead.`
                : remote
                  ? "Steps 1 and 3 happen in T3 Code on your computer; the pasting happens here."
                  : "Pair once; lalala remembers it on this device."}
            </p>
          </div>
        </div>
      )}
      {/* role=list: list-style none drops the list's semantics in Safari. */}
      <ol role="list" data-lalala-pair="" data-lalala-pair-steps="" aria-label="Steps to pair">
        {ask ? (
          <Step n={1} title="Paste your T3 Connect address">
            <T3Path steps={["Settings", "Environments", "⋯", "Copy MCP URL"]} />
            {field("", "Your T3 Connect address")}
            <p data-lalala-pair-alt="">
              <button type="button" data-lalala-settings-button="" data-quiet="" disabled={busy} onClick={ask.onBack}>
                Back
              </button>
            </p>
          </Step>
        ) : path === "here" ? (
          <>
            <Step n={1} title="Create a pairing link in T3 Code">
              <T3Path steps={["Settings", "Sharing & access", "Create link"]} />
              <details data-lalala-pair-terminal="">
                <summary>Use a terminal instead</summary>
                {command(props.command)}
              </details>
            </Step>
            <Step n={2} title="Paste the link or code">
              {field("Paste link or code", "Pairing link or code")}
            </Step>
          </>
        ) : (
          <>
            <Step n={1} title="Turn these on in T3 Code">
              <T3Path steps={["Settings", "Sharing & access"]} />
              <p data-lalala-pair-or="">Like this, both on (T3 Connect asks you to sign in first):</p>
              <T3Switches names={["T3 Connect", "Network access"]} />
            </Step>
            <Step n={2} title="Paste your T3 Connect address">
              <T3Path steps={["Settings", "Environments", "⋯", "Copy MCP URL"]} />
              <div data-lalala-pair-field="" data-plain="">
                <input
                  type="url"
                  inputMode="url"
                  aria-label="Your T3 Connect address"
                  placeholder="https://….t3coderelay.com/mcp"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-streamer-input={streamer ? "" : undefined}
                  value={connectAddress}
                  disabled={busy}
                  onChange={(event) => setConnectAddress(event.currentTarget.value)}
                />
              </div>
            </Step>
            <Step n={3} title="Create a pairing link in T3 Code">
              <T3Path steps={["Settings", "Sharing & access", "Create link"]} />
              <details data-lalala-pair-terminal="">
                <summary>Use a terminal instead</summary>
                {command(connectCommand, "Paste your address in step 2 first.")}
              </details>
            </Step>
            <Step n={4} title={phone ? "Paste the link or code here" : "Paste the link or code"}>
              {field("Paste link or code", "Pairing link or code")}
            </Step>
          </>
        )}
      </ol>
      {remote ? (
        <p data-lalala-pair-privacy="">Speech stays in this browser; only your words, as text, reach T3 Code.</p>
      ) : null}
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
        <p id={`${choiceId}e`} data-lalala-settings-error="" role="alert">
          <StreamerText text={props.problem} />
        </p>
      ) : null}
      {props.children}
    </>
  );

  function pick(next: Where) {
    setWhere(next);
    try {
      localStorage.setItem(WHERE_KEY, next);
    } catch {
      // No storage: asked again next time.
    }
  }
}

type Where = "here" | "other";
const WHERE_KEY = "lalala:pair-where";
const WHERES: ReadonlyArray<{ readonly id: Where; readonly label: string; readonly detail: string }> = [
  { id: "here", label: "This computer", detail: "T3 Code runs here, on the computer with this browser" },
  {
    id: "other",
    label: "Another computer",
    detail: "T3 Code runs on a different machine, like your Mac at home; lalala reaches it through T3 Connect",
  },
];
function readWhere(): Where {
  try {
    return localStorage.getItem(WHERE_KEY) === "other" ? "other" : "here";
  } catch {
    return "here";
  }
}

/** One numbered step: what to do, then the place in T3 Code or the control that does it. */
function Step(props: { readonly n: number; readonly title: string; readonly children: ReactNode }) {
  return (
    <li data-lalala-pair-step="">
      <span aria-hidden="true">{props.n}</span>
      <div>
        <h4>{props.title}</h4>
        {props.children}
      </div>
    </li>
  );
}

/** Where a setting lives in T3 Code, as the chips it shows, not a sentence. */
function T3Path(props: { readonly steps: ReadonlyArray<string> }) {
  return (
    <p data-lalala-t3-path="">
      <span data-lalala-settings-sr="">In T3 Code: </span>
      {/* A chip keeps the › after it, so a wrapped line never starts with one. */}
      {props.steps.map((step, index) => (
        <span key={step}>
          <b>{step}</b>
          {index < props.steps.length - 1 ? <i aria-hidden="true">›</i> : null}
        </span>
      ))}
    </p>
  );
}

/** T3 Code's switches as they look once on: a picture of its settings, not a control here. */
function T3Switches(props: { readonly names: ReadonlyArray<string> }) {
  return (
    <ul data-lalala-t3-switches="">
      {props.names.map((name) => (
        <li key={name}>
          <span>{name}</span>
          <span data-lalala-settings-sr="">: on</span>
          <span data-lalala-t3-switch="" aria-hidden="true" />
        </li>
      ))}
    </ul>
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
