import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { isFollowing, setFollowing, subscribeFollow } from "./follow";
import { useStreamerMode } from "./streamerMode";
import { topicChime } from "./player";
import {
  BUILT_IN_TOPIC_SOUND,
  DEFAULT_TOPIC_SOUND,
  type Delegates,
  type OptionValue,
  pullSynced,
  setMicDeviceId,
  topicSoundNames,
  topicSoundUrl,
  updateSynced,
  useMicDeviceId,
  useSyncedSettings,
} from "./settingsStore";
import "./voiceSettings.css";

// What the dev server's T3 bridge serves (lalala's vite/t3bridge.mjs): the brain thread's model and
// T3's providers with each model's own options (T3's ProviderOptionDescriptor).
type Choice = { readonly id: string; readonly label: string; readonly isDefault?: boolean };
type Descriptor =
  | {
      readonly type: "select";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly options: ReadonlyArray<Choice>;
      readonly currentValue?: string;
      readonly role?: "reasoning";
    }
  | {
      readonly type: "boolean";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly currentValue?: boolean;
    };
type Model = { readonly slug: string; readonly name: string; readonly options: Descriptor[] };
type Provider = { readonly instanceId: string; readonly name: string; readonly models: Model[] };
type Selection = {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: OptionValue }>;
};
type Brain = {
  readonly modelSelection: Selection | null;
  readonly providers: ReadonlyArray<Provider>;
};
type BrainState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string; readonly brain: Brain | null }
  | { readonly kind: "ready"; readonly brain: Brain; readonly saving: boolean };

// What the standalone's bridge says about its link to the harness (lalala's vite/t3bridge.mjs).
type Connection = {
  readonly harness: string;
  readonly paired: boolean;
  readonly connected: boolean;
  readonly error: string | null;
  readonly origin: string | null;
  readonly canPairLocal: boolean;
  readonly server: { readonly label: string; readonly version: string } | null;
  readonly session: { readonly expiresAt: number; readonly renews: boolean } | null;
  readonly brainThread: { readonly id: string; readonly title: string | null } | null;
};
type ConnectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "inside" }
  | { readonly kind: "ready"; readonly connection: Connection };

const BRAIN_ROUTE = "/__lalala/t3/brain";
const CONNECTION_ROUTE = "/__lalala/t3/connection";
const STREAMER_KEY = "lalala:streamer";

const isReasoning = (d: Descriptor) =>
  d.type === "select" &&
  (d.role === "reasoning" || d.id === "effort" || d.id === "reasoningEffort");

/** A descriptor's value: the given one when the model offers it, else the model's own default. */
function valueOf(d: Descriptor, given: OptionValue | undefined): OptionValue {
  if (d.type === "boolean") return typeof given === "boolean" ? given : (d.currentValue ?? false);
  if (typeof given === "string" && d.options.some((choice) => choice.id === given)) return given;
  return (
    d.currentValue ?? d.options.find((choice) => choice.isDefault)?.id ?? d.options[0]?.id ?? ""
  );
}

const findModel = (brain: Brain, instanceId: string | null, slug: string | null) =>
  brain.providers.find((p) => p.instanceId === instanceId)?.models.find((m) => m.slug === slug);

const optionMap = (selection: Selection | null): Record<string, OptionValue> =>
  Object.fromEntries((selection?.options ?? []).map((option) => [option.id, option.value]));

/**
 * Options for a model, carrying over what was set: reasoning by meaning (Claude's `effort` is
 * Codex's `reasoningEffort`), the rest by id.
 */
function carryOptions(model: Model | undefined, from: Record<string, OptionValue>) {
  const reasoning = Object.entries(from).find(
    ([id]) => id === "effort" || id === "reasoningEffort",
  );
  return Object.fromEntries(
    (model?.options ?? []).map((d) => [
      d.id,
      valueOf(d, from[d.id] ?? (isReasoning(d) ? reasoning?.[1] : undefined)),
    ]),
  );
}

const modelKey = (instanceId: string, slug: string) => `${instanceId}\n${slug}`;
const splitKey = (key: string) => {
  const [instanceId = "", slug = ""] = key.split("\n");
  return { instanceId, slug };
};

/**
 * The voice's settings: the gear tab in the bar's row, there in and out of a call, opens
 * them over the page as one page of grouped rows (so few options need no sub-pages). `children`
 * replaces the app's sections (lalala.talk shows only what works in a browser).
 */
export function VoiceSettings(props: {
  readonly tabHost: HTMLElement;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the other devices' newer settings when this page comes back into view
  useEffect(() => {
    pullSynced();
    const onVisible = () => {
      if (document.visibilityState === "visible") pullSynced();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return (
    <>
      {createPortal(
        <button
          type="button"
          data-lalala-settings-tab=""
          data-open={open ? "" : undefined}
          aria-expanded={open}
          aria-label="Voice settings"
          onClick={() => setOpen(!open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>,
        props.tabHost,
      )}
      {open
        ? createPortal(
            <SettingsSheet onClose={() => setOpen(false)}>
              {props.children ?? <AppSections />}
            </SettingsSheet>,
            document.body,
          )
        : null}
    </>
  );
}

const fetchBrain = () =>
  fetch(BRAIN_ROUTE, { cache: "no-store" })
    .then(async (response): Promise<BrainState> => {
      if (response.status === 404) return { kind: "missing" };
      const body = (await response.json().catch(() => ({}))) as Brain & { error?: string };
      return response.ok
        ? { kind: "ready", brain: body, saving: false }
        : { kind: "error", message: body.error ?? "T3 did not answer", brain: null };
    })
    .catch((cause: unknown): BrainState => ({
      kind: "error",
      message: String(cause),
      brain: null,
    }));

function SettingsSheet(props: { readonly onClose: () => void; readonly children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onClose = props.onClose;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the newest synced settings while the sheet is open; Esc closes it
  useEffect(() => {
    pullSynced();
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div data-lalala-settings="" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Voice settings"
        tabIndex={-1}
        data-lalala-settings-panel=""
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h1>Settings</h1>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div data-lalala-settings-body="">{props.children}</div>
      </div>
    </div>
  );
}

/** The app's sections: the harness connection, the brain's and new threads' models, sound, canvas. */
function AppSections() {
  const [brain, setBrain] = useState<BrainState>({ kind: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the brain thread's model and T3's models from the dev server while the sheet is open
  useEffect(() => {
    let cancelled = false;
    void fetchBrain().then((next) => {
      if (!cancelled) setBrain(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const configureBrain = (selection: Selection) => {
    if (brain.kind !== "ready") return;
    const before = brain.brain;
    setBrain({ kind: "ready", brain: { ...before, modelSelection: selection }, saving: true });
    void fetch(BRAIN_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSelection: selection }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Brain & { error?: string };
        setBrain(
          response.ok
            ? { kind: "ready", brain: body, saving: false }
            : { kind: "error", message: body.error ?? "T3 refused the change", brain: before },
        );
      })
      .catch((cause: unknown) =>
        setBrain({ kind: "error", message: String(cause), brain: before }),
      );
  };

  const known = brain.kind === "ready" ? brain.brain : brain.kind === "error" ? brain.brain : null;

  return (
    <>
      <ConnectionSection onChange={() => void fetchBrain().then(setBrain)} />
      <BrainSection state={brain} onConfigure={configureBrain} />
      <ThreadsSection brain={known} />
      <SoundSection />
      <CanvasRows />
    </>
  );
}

export function Section(props: {
  readonly title?: string;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section data-lalala-settings-section="" aria-label={props.title ?? "Canvas"}>
      {props.title ? <h2>{props.title}</h2> : null}
      {props.note ? <p data-lalala-settings-note="">{props.note}</p> : null}
      {props.children ? <div data-lalala-settings-group="">{props.children}</div> : null}
    </section>
  );
}

export function Row(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly below?: ReactNode;
}) {
  return (
    <div data-lalala-settings-row="">
      <div>
        <h3>{props.title}</h3>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      <div data-lalala-settings-control="">{props.children}</div>
      {props.below}
    </div>
  );
}

function Toggle(props: {
  readonly on: boolean;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      data-lalala-settings-switch=""
      onClick={() => props.onChange(!props.on)}
    >
      <span />
    </button>
  );
}

type PickOption = {
  readonly value: string;
  readonly label: string;
  /** The row gets a play button (onPlay). */
  readonly playable?: boolean;
};
type PickGroup = { readonly label?: string; readonly options: ReadonlyArray<PickOption> };

const modelGroups = (providers: ReadonlyArray<Provider>): PickGroup[] =>
  providers.map((provider) => ({
    label: provider.name,
    options: provider.models.map((model) => ({
      value: modelKey(provider.instanceId, model.slug),
      label: model.name,
    })),
  }));

let previewAudio: HTMLAudioElement | null = null;
function playTopicSound(name: string): void {
  previewAudio?.pause();
  previewAudio = null;
  const url = topicSoundUrl(name);
  if (url !== null) {
    previewAudio = new Audio(url);
    void previewAudio.play().catch(() => undefined);
    return;
  }
  if (name !== BUILT_IN_TOPIC_SOUND) return;
  const context = new AudioContext();
  const samples = topicChime(context.sampleRate);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.addEventListener("ended", () => void context.close());
  source.start();
}

/**
 * A row whose control picks one of a list, in the panel's own look instead of the browser's select:
 * the button shows the choice, the list opens inline under the row (no popover to clip, no iOS wheel).
 * Arrows, Home/End, Enter and Esc work like a listbox.
 */
function PickRow(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly groups: ReadonlyArray<PickGroup>;
  readonly disabled?: boolean | undefined;
  /** Plays a playable option: from its button, and as the keyboard moves onto it. */
  readonly onPlay?: (value: string) => void;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options = props.groups.flatMap((group) => group.options);
  const selected = options.findIndex((option) => option.value === props.value);
  const optionId = (index: number) => `${id}o${index}`;

  const listEl = useRef<HTMLDivElement | null>(null);
  // Once per opening: without the React Compiler (the standalone) a new callback reruns every render.
  const listRef = (node: HTMLDivElement | null) => {
    if (node === null || node === listEl.current) return;
    listEl.current = node;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest" });
    node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const show = () => {
    setActive(Math.max(selected, 0));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option && option.value !== props.value) props.onChange(option.value);
    close();
  };
  const move = (index: number) => {
    const next = Math.min(Math.max(index, 0), options.length - 1);
    const option = options[next];
    if (option === undefined) return;
    setActive(next);
    if (option.playable) props.onPlay?.(option.value);
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  };
  const onListKey = (event: ReactKeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: options.length - 1,
      PageDown: active + 8,
      PageUp: active - 8,
    };
    if (event.key in step) move(step[event.key]!);
    else if (event.key === "Enter" || event.key === " ") pick(active);
    else if (event.key === "Escape") close();
    else if (event.key === "Tab") return setOpen(false);
    else return;
    event.preventDefault();
  };

  let index = 0;
  return (
    <Row
      title={props.title}
      description={props.description}
      below={
        open ? (
          <div
            ref={listRef}
            role="listbox"
            id={`${id}l`}
            aria-label={props.label}
            aria-activedescendant={optionId(active)}
            tabIndex={-1}
            data-lalala-settings-list=""
            onKeyDown={onListKey}
            onBlur={(event) => {
              const to = event.relatedTarget;
              if (to !== triggerRef.current && !event.currentTarget.contains(to)) setOpen(false);
            }}
          >
            {props.groups.map((group, groupIndex) => (
              <div key={group.label ?? groupIndex} role="group" aria-label={group.label}>
                {group.label ? <div aria-hidden="true">{group.label}</div> : null}
                {group.options.map((option) => {
                  const at = index++;
                  return (
                    <div
                      key={option.value}
                      id={optionId(at)}
                      role="option"
                      aria-selected={at === selected}
                      data-active={at === active ? "" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => at !== active && setActive(at)}
                      onClick={() => pick(at)}
                    >
                      {props.onPlay ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Play ${option.label}`}
                          disabled={!option.playable}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActive(at);
                            props.onPlay?.(option.value);
                          }}
                        >
                          <svg viewBox="0 0 10 10" aria-hidden="true">
                            <path d="M2.5 1.5v7l6-3.5z" />
                          </svg>
                        </button>
                      ) : null}
                      <span>{option.label}</span>
                      {at === selected ? (
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2 6.5l2.5 2.5L10 3.5" />
                        </svg>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null
      }
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}l` : undefined}
        aria-label={`${props.label}: ${options[selected]?.label ?? "none"}`}
        disabled={props.disabled}
        data-lalala-settings-pick=""
        data-open={open ? "" : undefined}
        // Safari never focuses a clicked button: the list would blur shut and the click reopen it.
        onMouseDown={(event) => open && event.preventDefault()}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
      >
        <span>{options[selected]?.label ?? "None"}</span>
      </button>
    </Row>
  );
}

/** One row per option the model offers (reasoning, fast mode, …), in T3's own words. */
function OptionRows(props: {
  readonly model: Model | undefined;
  readonly values: Record<string, OptionValue>;
  readonly disabled?: boolean | undefined;
  readonly onChange: (id: string, value: OptionValue) => void;
}) {
  return (props.model?.options ?? []).map((d) =>
    d.type === "boolean" ? (
      <Row key={d.id} title={d.label} description={d.description}>
        <Toggle
          on={valueOf(d, props.values[d.id]) === true}
          label={d.label}
          disabled={props.disabled}
          onChange={(on) => props.onChange(d.id, on)}
        />
      </Row>
    ) : (
      <PickRow
        key={d.id}
        title={d.label}
        description={d.description}
        label={d.label}
        value={String(valueOf(d, props.values[d.id]))}
        groups={[
          { options: d.options.map((choice) => ({ value: choice.id, label: choice.label })) },
        ]}
        disabled={props.disabled}
        onChange={(value) => props.onChange(d.id, value)}
      />
    ),
  );
}

const sendConnection = (path: string, body?: object) =>
  fetch(`${CONNECTION_ROUTE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(async (response) => {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `answered ${response.status}`);
    return result;
  });

const untilDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

const fetchConnection = () =>
  fetch(CONNECTION_ROUTE, { cache: "no-store" })
    .then(async (response): Promise<ConnectionState> => {
      if (response.status === 404) return { kind: "inside" };
      return { kind: "ready", connection: (await response.json()) as Connection };
    })
    .catch((cause: unknown): ConnectionState => ({
      kind: "ready",
      connection: {
        harness: "T3 Code",
        paired: false,
        connected: false,
        error: String(cause),
        origin: null,
        canPairLocal: false,
        server: null,
        session: null,
        brainThread: null,
      },
    }));

/**
 * The harness the voice works through: T3 Code today, the one the standalone's bridge
 * pairs with. Inside T3 Code itself (no bridge route) there is nothing to set.
 */
function ConnectionSection(props: { readonly onChange: () => void }) {
  const [state, setState] = useState<ConnectionState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const onChange = props.onChange;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the bridge's link to the harness while the sheet is open
  useEffect(() => {
    let cancelled = false;
    void fetchConnection().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const act = (path: string, body?: object) => {
    setBusy(true);
    setProblem(null);
    setTest(null);
    void sendConnection(path, body)
      .then((result) => {
        if (path === "/test") {
          const { ms } = result as { ms?: number };
          setTest(`answered in ${ms ?? "?"} ms`);
        } else {
          setLink("");
          onChange();
        }
      })
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .then(fetchConnection)
      .then((next) => {
        setState(next);
        setBusy(false);
      });
  };

  const title = "Connection";
  if (state.kind === "loading") return <Section title={title} note="Reading the connection…" />;
  if (state.kind === "inside") {
    return (
      <Section title={title} note="The voice runs inside T3 Code, so it is always connected." />
    );
  }
  const c = state.connection;
  const error = c.error?.replace(/^T3: /, "") ?? null;
  const where = [c.origin, c.server ? `${c.server.label} · v${c.server.version}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Section title={title} note="The coding harness the voice works through.">
      {problem ? <p data-lalala-settings-error="">{problem}</p> : null}
      <Row
        title={c.harness}
        description={
          c.connected
            ? [where, test].filter(Boolean).join(" · ")
            : (error ?? (c.paired ? where : "Not paired yet."))
        }
      >
        <span data-lalala-settings-status="" data-ok={c.connected ? "" : undefined}>
          {c.connected ? "Connected" : "Not connected"}
        </span>
        {c.paired ? (
          <button
            type="button"
            data-lalala-settings-button=""
            disabled={busy}
            onClick={() => act("/test")}
          >
            Test
          </button>
        ) : null}
      </Row>
      {c.paired && c.brainThread ? (
        <Row title="Brain thread">
          <span data-lalala-settings-value="">{c.brainThread.title ?? c.brainThread.id}</span>
        </Row>
      ) : null}
      {c.paired && c.session ? (
        <Row
          title="Session"
          description={
            c.session.renews ? "Renews itself a week before it ends." : "Pair again before it ends."
          }
        >
          <span data-lalala-settings-value="">Until {untilDate(c.session.expiresAt)}</span>
        </Row>
      ) : null}
      {c.paired ? (
        <Row
          title="Pairing"
          description="Forget this pairing; the voice stops until you pair again."
        >
          <button
            type="button"
            data-lalala-settings-button=""
            data-danger=""
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Disconnect from ${c.harness}?`)) act("/disconnect");
            }}
          >
            Disconnect
          </button>
        </Row>
      ) : (
        <>
          <Row
            title="Pairing link"
            description="Make a pairing link in T3 Code's Connections settings and paste it here."
          >
            <input
              type="url"
              aria-label="Pairing link"
              placeholder="https://…/pair#token=…"
              autoComplete="off"
              spellCheck={false}
              value={link}
              disabled={busy}
              onChange={(event) => setLink(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && link.trim() !== "")
                  act("/pair", { link: link.trim() });
              }}
            />
            <button
              type="button"
              data-lalala-settings-button=""
              disabled={busy || link.trim() === ""}
              onClick={() => act("/pair", { link: link.trim() })}
            >
              Connect
            </button>
          </Row>
          {c.canPairLocal ? (
            <Row title="This computer" description="Pair with the T3 Code running here.">
              <button
                type="button"
                data-lalala-settings-button=""
                disabled={busy}
                onClick={() => act("/pair", { local: true })}
              >
                Pair
              </button>
            </Row>
          ) : null}
        </>
      )}
    </Section>
  );
}

function BrainSection(props: {
  readonly state: BrainState;
  readonly onConfigure: (selection: Selection) => void;
}) {
  const { state } = props;
  const title = "Voice brain";
  if (state.kind === "loading") return <Section title={title} note="Reading T3…" />;
  if (state.kind === "missing") {
    return (
      <Section
        title={title}
        note="The brain's model is set here in the voice app. In T3 Code, use the voice thread's model picker."
      />
    );
  }
  const brain = state.brain;
  const error = state.kind === "error" ? state.message : null;
  if (brain === null) return <Section title={title} note={error} />;
  const selection = brain.modelSelection;
  const model = selection ? findModel(brain, selection.instanceId, selection.model) : undefined;
  const values = carryOptions(model, optionMap(selection));
  const saving = state.kind === "ready" && state.saving;

  return (
    <Section
      title={title}
      note="The thread you talk to. Changes apply from its next turn, on every device."
    >
      {error ? <p data-lalala-settings-error="">{error}</p> : null}
      <PickRow
        title="Model"
        label="Voice brain model"
        groups={modelGroups(brain.providers)}
        value={selection ? modelKey(selection.instanceId, selection.model) : ""}
        disabled={saving}
        onChange={(key) => {
          const { instanceId, slug } = splitKey(key);
          const next = findModel(brain, instanceId, slug);
          const options = carryOptions(next, values);
          props.onConfigure({
            instanceId,
            model: slug,
            options: Object.entries(options).map(([id, value]) => ({ id, value })),
          });
        }}
      />
      <OptionRows
        model={model}
        values={values}

        disabled={saving || selection === null}
        onChange={(id, value) => {
          if (selection === null) return;
          const options = { ...values, [id]: value };
          props.onConfigure({
            instanceId: selection.instanceId,
            model: selection.model,
            options: Object.entries(options).map(([key, option]) => ({ id: key, value: option })),
          });
        }}
      />
    </Section>
  );
}

function ThreadsSection(props: { readonly brain: Brain | null }) {
  const { delegates } = useSyncedSettings();
  const brain = props.brain;
  // "Same as the brain" is delegate_task's own default: no provider or model given.
  const brainModel =
    brain && brain.modelSelection
      ? findModel(brain, brain.modelSelection.instanceId, brain.modelSelection.model)
      : undefined;
  const model =
    delegates.model === null
      ? brainModel
      : brain
        ? findModel(brain, delegates.instanceId, delegates.model)
        : undefined;
  const set = (next: Delegates) => updateSynced({ delegates: next });

  return (
    <Section
      title="New threads"
      note="What the brain gives the threads it delegates to. Sent with each message, on every device."
    >
      {brain ? (
        <PickRow
          title="Model"
          label="Model for new threads"
          groups={[
            {
              options: [
                {
                  value: "",
                  label: `Same as the brain${brainModel ? ` (${brainModel.name})` : ""}`,
                },
              ],
            },
            ...modelGroups(brain.providers),
          ]}
          value={
            delegates.model === null || delegates.instanceId === null
              ? ""
              : modelKey(delegates.instanceId, delegates.model)
          }
          onChange={(key) => {
            if (key === "") {
              return set({
                instanceId: null,
                model: null,
                options: carryOptions(brainModel, delegates.options),
              });
            }
            const { instanceId, slug } = splitKey(key);
            set({
              instanceId,
              model: slug,
              options: carryOptions(findModel(brain, instanceId, slug), delegates.options),
            });
          }}
        />
      ) : (
        <Row title="Model">
          <span data-lalala-settings-value="">{delegates.model ?? "Same as the brain"}</span>
        </Row>
      )}
      {model ? (
        <OptionRows
          model={model}
          values={delegates.options}

          onChange={(id, value) =>
            set({
              ...delegates,
              options: { ...carryOptions(model, delegates.options), [id]: value },
            })
          }
        />
      ) : (
        Object.entries(delegates.options).map(([id, value]) => (
          <Row
            key={id}
            title={id === "fastMode" ? "Fast mode" : id === "effort" ? "Reasoning" : id}
          >
            <span data-lalala-settings-value="">{String(value)}</span>
          </Row>
        ))
      )}
    </Section>
  );
}

export function SoundSection() {
  const { topicSound } = useSyncedSettings();
  const mic = useMicDeviceId();
  const [mics, setMics] = useState<ReadonlyArray<MediaDeviceInfo> | null>(null);
  const names = topicSoundNames();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the microphones and follows them being plugged in or out
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (devices === undefined) return;
    let cancelled = false;
    const list = () =>
      void devices.enumerateDevices().then((all) => {
        if (!cancelled) setMics(all.filter((device) => device.kind === "audioinput"));
      });
    list();
    devices.addEventListener("devicechange", list);
    return () => {
      cancelled = true;
      devices.removeEventListener("devicechange", list);
    };
  }, []);

  const named = (mics ?? []).filter((device) => device.deviceId !== "" && device.label !== "");
  return (
    <Section title="Sound & mic">
      <PickRow
        title="Topic sound"
        description="Plays before the voice turns to something new, like a thread's result."
        label="Topic sound"
        value={topicSound}
        groups={[
          {
            options: [
              { value: "none", label: "None" },
              { value: BUILT_IN_TOPIC_SOUND, label: "Chime (built in)", playable: true },
              {
                value: DEFAULT_TOPIC_SOUND,
                label: `${DEFAULT_TOPIC_SOUND.replaceAll("-", " ")} (default)`,
                playable: true,
              },
              ...names
                .filter((name) => name !== DEFAULT_TOPIC_SOUND)
                .map((name) => ({ value: name, label: name.replaceAll("-", " "), playable: true })),
            ],
          },
        ]}
        onPlay={playTopicSound}
        onChange={(name) => {
          updateSynced({ topicSound: name });
          playTopicSound(name);
        }}
      />
      <PickRow
        title="Microphone"
        description={
          named.length === 0 && mics !== null
            ? "Start a call once to let the page name this device's microphones."
            : "Used from the next call."
        }
        label="Microphone"
        value={mic !== null && named.some((device) => device.deviceId === mic) ? mic : ""}
        groups={[
          {
            options: [
              { value: "", label: "System default" },
              ...named.map((device) => ({ value: device.deviceId, label: device.label })),
            ],
          },
        ]}
        onChange={(id) => setMicDeviceId(id || null)}
      />
    </Section>
  );
}

export function CanvasRows() {
  const following = useSyncExternalStore(subscribeFollow, isFollowing, () => false);
  const streamer = useStreamerMode();
  return (
    <Section>
      <Row
        title="Follow the voice"
        description="The canvas moves to the cards the voice talks about. Also the Follow tab, or say “follow”."
      >
        <Toggle on={following} label="Follow the voice" onChange={setFollowing} />
      </Row>
      <Row
        title="Streamer mode"
        description="Scrambles thread titles and message text, for screen sharing."
      >
        <Toggle
          on={streamer}
          label="Streamer mode"
          onChange={(on) => {
            try {
              localStorage.setItem(STREAMER_KEY, on ? "on" : "off");
            } catch {
              return;
            }
            window.dispatchEvent(new Event(STREAMER_KEY));
          }}
        />
      </Row>
    </Section>
  );
}
