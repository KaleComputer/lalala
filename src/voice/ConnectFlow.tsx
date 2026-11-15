import { Fragment, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(text);
        setCopyFailed(false);
        window.setTimeout(() => setCopied((now) => (now === text ? null : now)), 2000);
      },
      () => {
        setCopied(null);
        setCopyFailed(true);
      },
    );
  const streamer = useStreamerMode();
  const busy = props.working !== null;
  const addressRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // The address only says it's wrong once it was left, pasted or blocked a pairing, not per keystroke.
  const [addressChecked, setAddressChecked] = useState(false);
  const submit = (input: string, address = connectAddress) => {
    const value = input.trim();
    if (value === "" || busy) return;
    if (ask) return ask.onAddress(value);
    // A wrong address in step 2 is fixed first; it is never skipped for another route.
    if (path === "other" && wrongAddress(address)) {
      setAddressChecked(true);
      addressRef.current?.focus();
      return;
    }
    props.onPair(value, path === "other" && commandFor(address) !== null ? address.trim() : undefined);
  };
  const value = ask ? (address ?? ask.address) : link;
  const setValue = ask ? setAddress : setLink;
  // lalala.talk offers two ways in; a phone is never the computer T3 Code runs on.
  const remote = props.connectCommand !== undefined;
  const [where, setWhere] = useState<Where>(() => (isPhone() ? "other" : readWhere()));
  const path: Where = remote && !isPhone() ? where : remote ? "other" : "here";
  const [connectAddress, setConnectAddress] = useState("");
  const hostOfAddress = (address: string) =>
    address
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/(mcp)?\/?$/i, "");
  // Only a real host fills the command: the placeholder would be a shell redirect.
  const commandFor = (address: string) => {
    const host = hostOfAddress(address);
    return props.connectCommand && /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/i.test(host)
      ? props.connectCommand.replace("<your T3 Connect address>", host)
      : null;
  };
  const wrongAddress = (address: string) => hostOfAddress(address) !== "" && commandFor(address) === null;
  const connectCommand = commandFor(connectAddress);
  const phone = isPhone();
  const addressWrong = addressChecked && wrongAddress(connectAddress);

  const field = (placeholder: string, label: string) => (
    <div data-lalala-pair-field="" data-failed={props.problem ? "" : undefined}>
      <input
        ref={linkRef}
        key={ask ? "address" : "link"}
        type={ask ? "url" : "text"}
        inputMode={ask ? "url" : undefined}
        aria-label={ask ? "Your T3 Connect address" : label}
        aria-invalid={props.problem ? true : undefined}
        // The error when there is one; while empty, why Connect sent you here.
        aria-describedby={
          props.problem ? `${choiceId}e` : value.trim() === "" && !busy ? `${choiceId}n` : undefined
        }
        placeholder={ask ? "https://name.t3coderelay.com/mcp" : placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="go"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field to fill once the address is asked for
        autoFocus={ask !== null}
        data-streamer-input={streamer ? "" : undefined}
        value={value}
        // Read-only (not disabled) while pairing: focus stays here for the result.
        readOnly={busy}
        aria-busy={busy || undefined}
        onChange={(event) => setValue(event.currentTarget.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text").trim();
          const field = event.currentTarget;
          // Only a paste over the whole field sends it; pasting into part of it stays a normal paste.
          const whole = field.value === "" || (field.selectionStart === 0 && field.selectionEnd === field.value.length);
          if (pasted === "" || !whole || busy) return;
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
      {/* Always there, so the step ends in its action; inactive until there's something to send. */}
      <button
        type="button"
        data-lalala-settings-button=""
        aria-disabled={busy || value.trim() === "" || undefined}
        aria-describedby={value.trim() === "" && !busy ? `${choiceId}n` : undefined}
        // Nothing to send yet: the tap lands in the field instead.
        onClick={() => (busy ? undefined : value.trim() === "" ? linkRef.current?.focus() : submit(value))}
      >
        {busy ? "Connecting…" : ask ? "Next" : "Connect"}
      </button>
      <span id={`${choiceId}n`} data-lalala-settings-sr="">
        {ask ? "Paste your T3 Connect address first" : "Paste the link or code first"}
      </span>
    </div>
  );
  const command = (text: string | null, missing?: string) => (
    <p data-lalala-pair-command="" data-missing={text === null ? "" : undefined}>
      <code>
        {/* Each word moves to the next line whole, so an address never breaks at its hyphen. */}
        {text === null
          ? missing
          : text.split(" ").map((word, index) => (
              <Fragment key={index}>
                {index > 0 ? " " : null}
                <span>{word}</span>
              </Fragment>
            ))}
        {copyFailed && text !== null ? <span aria-hidden="true"> (Couldn't copy: select it and copy.)</span> : null}
      </code>
      <span role="status" data-lalala-settings-sr="">
        {text !== null && copied === text ? "Copied" : copyFailed ? "Couldn't copy: select the command and copy it." : ""}
      </span>
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
                  ? "Do these on your computer, then paste here."
                  : "Pair once; lalala remembers it on this device."}
            </p>
          </div>
        </div>
      )}
      {/* role=list: list-style none drops the list's semantics in Safari. */}
      <ol role="list" data-lalala-pair="" data-lalala-pair-steps="" aria-label="Steps to pair">
        {ask ? (
          <Step n={1} title="Paste your T3 Connect address">
            <T3Path steps={["Settings", "Environments", "⋯ Copy MCP URL"]} />
            {field("", "Your T3 Connect address")}
            <p data-lalala-pair-alt="">
              <button type="button" data-lalala-settings-button="" data-quiet="" disabled={busy} onClick={ask.onBack}>
                Back
              </button>
            </p>
          </Step>
        ) : path === "here" ? (
          <>
            <Step n={1} title="Create a pairing link">
              <T3Path steps={["Settings", "Sharing & access", "Create link"]} />
              <details data-lalala-pair-terminal="">
                <summary>Use a terminal instead</summary>
                {command(props.command)}
              </details>
            </Step>
            <Step n={2} title="Paste the link or code">
              {field(phone ? "The link or code" : "https://…/pair#token=… or the code", "Pairing link or code")}
            </Step>
          </>
        ) : (
          <>
            <Step n={1} title={phone ? "Turn these on" : "On that computer, turn these on"}>
              <T3Path steps={["Settings", "Sharing & access"]} />
              <p data-lalala-pair-or="">Both on, like this. T3 Connect asks you to sign in first.</p>
              <T3Switches names={["T3 Connect", "Network access"]} />
            </Step>
            <Step
              n={2}
              title={
                "Paste your T3 Connect address"
              }
            >
              <T3Path steps={["Settings", "Environments", "⋯ Copy MCP URL"]} />
              <div data-lalala-pair-field="" data-plain="">
                <input
                  ref={addressRef}
                  type="url"
                  inputMode="url"
                  aria-label="Your T3 Connect address"
                  placeholder="https://name.t3coderelay.com/mcp"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  data-streamer-input={streamer ? "" : undefined}
                  value={connectAddress}
                  disabled={busy}
                  onChange={(event) => setConnectAddress(event.currentTarget.value)}
                  onBlur={() => setAddressChecked(connectAddress.trim() !== "")}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text").trim();
                    const field = event.currentTarget;
                    const whole =
                      field.value === "" || (field.selectionStart === 0 && field.selectionEnd === field.value.length);
                    if (pasted === "" || !whole) return;
                    event.preventDefault();
                    setConnectAddress(pasted);
                    setAddressChecked(true);
                    // A link held back by a wrong address goes as soon as the address is right.
                    if (!wrongAddress(pasted) && link.trim() !== "") submit(link, pasted);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    setAddressChecked(true);
                    if (wrongAddress(connectAddress)) return;
                    if (link.trim() !== "") submit(link);
                    else linkRef.current?.focus();
                  }}
                  aria-invalid={addressWrong || undefined}
                  aria-describedby={`${choiceId}a`}
                />
              </div>
              <p
                id={`${choiceId}a`}
                role="status"
                data-lalala-pair-or=""
                data-wrong={addressWrong ? "" : undefined}
              >
                {addressWrong ? "That isn't a T3 Connect address; copy the MCP URL again." : null}
              </p>
            </Step>
            <Step n={3} title="Create a pairing link">
              <T3Path steps={["Settings", "Sharing & access", "Create link"]} />
              <details data-lalala-pair-terminal="">
                <summary>{phone ? "Use a terminal on your computer instead" : "Use a terminal on that computer instead"}</summary>
                {command(
                  connectCommand,
                  "Paste your address in step 2 first.",
                )}
              </details>
            </Step>
            <Step n={4} title="Paste the link or code from step 3">
              {field(phone ? "The link or code" : "https://…/pair#token=… or the code", "Pairing link or code")}
            </Step>
          </>
        )}
      </ol>
      {remote ? (
        <p data-lalala-pair-privacy="">Your voice stays on your own devices: this one, or your computer through your paired T3 Code. The brain gets only your words, as text.</p>
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

const PRESS = new Set(["Create link"]);

/** Where a setting lives in T3 Code, as the chips it shows, not a sentence. */
function T3Path(props: { readonly steps: ReadonlyArray<string> }) {
  return (
    <p data-lalala-t3-path="">
      <span data-lalala-t3-lead="">In T3 Code</span>
      {/* A chip keeps the › before it, so a wrapped line never ends on one. */}
      {props.steps.map((step, index) => (
        <span key={step}>
          {index > 0 ? (
            <>
              <i aria-hidden="true">›</i>
              <span data-lalala-settings-sr="">, then </span>
            </>
          ) : null}
          {index === props.steps.length - 1 && PRESS.has(step) ? <span data-lalala-settings-sr="">press </span> : null}
          {step.startsWith("⋯ ") ? (
            // The menu and the item in it are one click path: one chip, so a phone's line never breaks between.
            <b data-press="">
              <span aria-hidden="true">⋯ </span>
              <span data-lalala-settings-sr="">the menu next to your computer's name, then press </span>
              {step.slice(2)}
            </b>
          ) : (
            // The last chip of a path is the button to press there: drawn as one.
            <b data-press={index === props.steps.length - 1 && PRESS.has(step) ? "" : undefined}>{step}</b>
          )}
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
