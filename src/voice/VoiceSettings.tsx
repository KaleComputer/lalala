import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { ConnectedRows, PairSteps } from "./ConnectFlow";
import { isFollowing, setFollowing, subscribeFollow } from "./follow";
import { pairingLink } from "./pairing";
import { StreamerText, useStreamerMode } from "./streamerMode";
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
import { setSoundVolume, soundOutput, useSoundVolume, withSoundVolume } from "./extras/soundVolume";
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
  readonly notice?: string | null;
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
  const at = useSyncExternalStore(subscribeOpen, readOpen, readOpen);
  const open = at !== null;

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
          onClick={() => (open ? closeVoiceSettings() : openVoiceSettings())}
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
            <SettingsSheet section={at} onClose={closeVoiceSettings}>
              {props.children ?? <AppSections />}
            </SettingsSheet>,
            document.body,
          )
        : null}
    </>
  );
}

// Whether the sheet is open, and at which section ("" for the top): anything can open it (the
// site's call button opens it at Connection), even before the bar has mounted.
let openAt: string | null = null;
const openListeners = new Set<() => void>();
const readOpen = () => openAt;
function subscribeOpen(listener: () => void) {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}
function setOpenAt(next: string | null) {
  openAt = next;
  for (const listener of openListeners) listener();
}
/** Opens the settings sheet, scrolled to the section with this title. */
export const openVoiceSettings = (section = "") => setOpenAt(section);
export const closeVoiceSettings = () => setOpenAt(null);
/** Calls `listener` whenever the settings sheet closes. */
export const onVoiceSettingsClosed = (listener: () => void) =>
  subscribeOpen(() => {
    if (openAt === null) listener();
  });

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

function SettingsSheet(props: {
  readonly section: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onClose = props.onClose;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the sheet (DOM) to the section it was opened at
  useEffect(() => {
    if (props.section === "") return;
    panelRef.current
      ?.querySelector(`[data-lalala-settings-section][aria-label="${CSS.escape(props.section)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [props.section]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the newest synced settings while the sheet is open; Esc closes it
  useEffect(() => {
    pullSynced();
    panelRef.current?.focus({ preventScroll: true });
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
  /** The label can identify the user (a device name, a project title): streamer mode scrambles it. */
  readonly hidden?: boolean;
};
const PickLabel = (props: { readonly option: PickOption | undefined }) =>
  props.option?.hidden ? <StreamerText text={props.option.label} /> : (props.option?.label ?? "None");
export type PickGroup = { readonly label?: string; readonly options: ReadonlyArray<PickOption> };

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
    previewAudio = withSoundVolume(new Audio(url));
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
  source.connect(soundOutput(context));
  source.addEventListener("ended", () => void context.close());
  source.start();
}

/**
 * A row whose control picks one of a list, in the panel's own look instead of the browser's select:
 * the button shows the choice, the list opens inline under the row (no popover to clip, no iOS wheel).
 * Arrows, Home/End, Enter and Esc work like a listbox.
 */
export function PickRow(props: {
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
                      <span>
                        <PickLabel option={option} />
                      </span>
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
        <span>
          <PickLabel option={options[selected]} />
        </span>
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

const PAIR_COMMAND = "npx t3 pair --scope orchestration:read --scope orchestration:operate --label lalala";
/** Asks T3 Code for one small answer through the bridge: what makes the link count as working. */
const checkConnection = () =>
  sendConnection("/test").then((result) => {
    const { ms } = result as { ms?: number };
    return `answered in ${ms ?? "?"} ms`;
  });
const describe = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /token exchange answered 40[01]/.test(message)
    ? "That pairing link was already used or expired. Make a new one in T3 Code."
    : message;
};

/**
 * The harness the voice works through: T3 Code today, the one the app's bridge pairs with. Paste a
 * pairing link and it pairs, checks the link and shows it connected; nothing else to click.
 */
function ConnectionSection(props: { readonly onChange: () => void }) {
  const [state, setState] = useState<ConnectionState>({ kind: "loading" });
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const onChange = props.onChange;

  const check = () => checkConnection().then(setChecked);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the bridge's link to the harness while the sheet is open, and checks it once
  useEffect(() => {
    let cancelled = false;
    void fetchConnection().then((next) => {
      if (cancelled) return;
      setState(next);
      if (next.kind !== "ready" || !next.connection.paired) return;
      checkConnection().then(
        (answer) => !cancelled && setChecked(answer),
        (cause: unknown) => !cancelled && setProblem(describe(cause)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = (label: string, work: () => Promise<unknown>) => {
    setWorking(label);
    setProblem(null);
    void work()
      .catch((cause: unknown) => setProblem(describe(cause)))
      .then(fetchConnection)
      .then((next) => {
        setState(next);
        setWorking(null);
      });
  };

  /** Pairs, then checks the link: T3 Code answering is what makes it Connected. */
  const pair = (body: object) =>
    run("Pairing with T3 Code…", async () => {
      setChecked(null);
      const result = (await sendConnection("/pair", body)) as unknown as Connection;
      if (!result.connected)
        throw new Error(result.error?.replace(/^T3: /, "") ?? "T3 Code did not answer. Is it running?");
      setWorking("Checking the connection…");
      await check();
      onChange();
    });

  const title = "Connection";
  if (state.kind === "loading") return <Section title={title} note="Reading the connection…" />;
  if (state.kind === "inside") {
    return (
      <Section title={title} note="The voice runs inside T3 Code, so it is always connected." />
    );
  }
  const c = state.connection;
  const note = "The coding harness the voice works through.";

  if (!c.paired) {
    return (
      <Section title={title} note={note}>
        <PairSteps
          reach="server"
          label="lalala"
          command={PAIR_COMMAND}
          working={working}
          problem={problem}
          onPair={(input) => {
            try {
              pair({ link: pairingLink(input) });
            } catch (cause) {
              setProblem(describe(cause));
            }
          }}
        >
          {c.canPairLocal ? (
            <Row title="Or this computer" description="Pair with the T3 Code running here, in one click.">
              <button
                type="button"
                data-lalala-settings-button=""
                disabled={working !== null}
                onClick={() => pair({ local: true })}
              >
                Pair
              </button>
            </Row>
          ) : null}
        </PairSteps>
      </Section>
    );
  }

  const error = c.connected ? null : (c.error?.replace(/^T3: /, "") ?? null);
  return (
    <Section title={title} note={note}>
      {c.notice ? <p data-lalala-settings-info="">{c.notice}</p> : null}
      <ConnectedRows
        ok={c.connected}
        where={[c.server ? `${c.server.label} · v${c.server.version}` : null, c.origin]
          .filter(Boolean)
          .join(" · ")}
        checked={working ?? checked}
        problem={problem ?? error}
        expiresAt={c.session?.expiresAt ?? null}
        renews={c.session?.renews}
        busy={working !== null}
        onRetest={() => run("checking…", check)}
        onDisconnect={() =>
          run("Disconnecting…", async () => {
            await sendConnection("/disconnect");
            setChecked(null);
          })
        }
      >
        {c.brainThread ? (
          <Row title="Thread">
            <span data-lalala-settings-value="">
              <StreamerText text={c.brainThread.title ?? c.brainThread.id} />
            </span>
          </Row>
        ) : null}
      </ConnectedRows>
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
  if (brain === null) return <Section title={title} note={error ? <StreamerText text={error} /> : null} />;
  const selection = brain.modelSelection;
  const model = selection ? findModel(brain, selection.instanceId, selection.model) : undefined;
  const values = carryOptions(model, optionMap(selection));
  const saving = state.kind === "ready" && state.saving;

  return (
    <Section
      title={title}
      note="The thread you talk to. Changes apply from its next turn, on every device."
    >
      {error ? (
        <p data-lalala-settings-error="">
          <StreamerText text={error} />
        </p>
      ) : null}
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
      <VolumeRow />
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
              ...named.map((device) => ({ value: device.deviceId, label: device.label, hidden: true })),
            ],
          },
        ]}
        onChange={(id) => setMicDeviceId(id || null)}
      />
    </Section>
  );
}

function VolumeRow() {
  const percent = Math.round(useSoundVolume() * 100);
  return (
    <Row
      title="Sounds & music"
      description="Every sound but the voice: the topic sound, chimes, cards and games. On this device."
    >
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label="Sounds & music volume"
        data-lalala-settings-range=""
        style={{ "--fill": `${percent}%` } as CSSProperties}
        onChange={(event) => setSoundVolume(Number(event.currentTarget.value) / 100)}
      />
      <span data-lalala-settings-value="">{percent}%</span>
    </Row>
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
