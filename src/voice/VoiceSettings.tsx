import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

import { useVoiceBrainContext } from "../state/voiceBrainContext";
import { formatTokens, useSharedBrainThread } from "./brainCompaction";
import { ConnectedRows, PairSteps } from "./ConnectFlow";
import { isFollowing, setFollowing, subscribeFollow } from "./follow";
import { isPairingCode, pairingLink } from "./pairing";
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

const OPTION_TITLES: Record<string, string> = {
  effort: "Reasoning",
  reasoningEffort: "Reasoning",
  fastMode: "Fast Mode",
  serviceTier: "Service Tier",
};
const optionText = (value: OptionValue) =>
  typeof value === "boolean"
    ? value
      ? "On"
      : "Off"
    : value.charAt(0).toUpperCase() + value.slice(1);
const soundTitle = (name: string) => optionText(name.replaceAll("-", " "));

const modelKey = (instanceId: string, slug: string) => `${instanceId}\n${slug}`;
const splitKey = (key: string) => {
  const [instanceId = "", slug = ""] = key.split("\n");
  return { instanceId, slug };
};

/**
 * The voice's settings: the gear tab in the bar's row, there in and out of a call, opens them over
 * the page in T3 Code's layout: a sidebar of pages on desktop; on a phone a list of the pages, each
 * opening on its own with Back. `pages` replaces the app's (lalala.talk shows only what works in a
 * browser).
 */
export function VoiceSettings(props: {
  readonly tabHost: HTMLElement;
  readonly pages?: ReadonlyArray<SettingsPage> | undefined;
}) {
  const at = useSyncExternalStore(subscribeOpen, readOpen, readOpen);
  const open = at !== null;
  const tabRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    closeVoiceSettings();
    tabRef.current?.focus({ preventScroll: true });
  }, []);

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
          ref={tabRef}
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
            props.pages ? (
              <SettingsSheet pages={props.pages} section={at} onClose={close} />
            ) : (
              <AppSettings section={at} onClose={close} />
            ),
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
/** Opens the settings sheet on the page with this title ("": a phone's list, a desktop's last page). */
export const openVoiceSettings = (section = "") => setOpenAt(section);
export const closeVoiceSettings = () => setOpenAt(null);
/** How long a fresh pairing shows Connected before the sheet closes and the call starts. */
export const CONNECTED_HOLD_MS = 1500;
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

/** A settings page: its place in the sidebar or list, its current value there, and its rows. */
export type SettingsPage = {
  readonly id: string;
  readonly title: string;
  readonly icon: ReadonlyArray<string>;
  readonly value?: string | undefined;
  readonly content: ReactNode;
};

/** The pages' icons, Lucide's paths. */
export const PAGE_ICONS = {
  connection: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
  brain: [
    "M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z",
  ],
  threads: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M12 7v6", "M9 10h6"],
  sound: [
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
    "M19 10v2a7 7 0 0 1-14 0v-2",
    "M12 19v3",
  ],
  canvas: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
  cards: ["M12 2 2 7l10 5 10-5-10-5z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
} as const;

const PAGE_KEY = "lalala:settings-page";
const PHONE = "(max-width: 640px)";

function lastPage(pages: ReadonlyArray<SettingsPage>): string {
  try {
    const stored = localStorage.getItem(PAGE_KEY);
    return pages.find((page) => page.id === stored)?.id ?? pages[0]?.id ?? "";
  } catch {
    return pages[0]?.id ?? "";
  }
}

function remember(page: string) {
  try {
    localStorage.setItem(PAGE_KEY, page);
  } catch {
    // Private mode: the sheet just opens on the first page next time.
  }
}

/** A media query as a store: the phone's list layout, and T3's icon rail under its md. */
function mediaStore(query: string) {
  return {
    matches: () => window.matchMedia(query).matches,
    subscribe(onChange: () => void) {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
  };
}
const PHONE_MEDIA = mediaStore(PHONE);
// Only for a mouse or trackpad: a touch tablet keeps the full sidebar, its names never hover.
const RAIL_MEDIA = mediaStore("(min-width: 641px) and (max-width: 767px) and (pointer: fine)");
const isPhone = PHONE_MEDIA.matches;

const Glyph = (props: { readonly d: ReadonlyArray<string> }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {props.d.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

/** The topic sound, beside Sound & mic in the phone's list. */
export function useSoundValue(): string {
  const { topicSound } = useSyncedSettings();
  return topicSound === "none"
    ? "No sound"
    : topicSound === BUILT_IN_TOPIC_SOUND
      ? "Chime"
      : soundTitle(topicSound);
}

/** Streamer mode or following, beside Canvas in the phone's list. */
export function useCanvasValue(): string {
  const streamer = useStreamerMode();
  const following = useSyncExternalStore(subscribeFollow, isFollowing, () => false);
  return streamer ? "Streamer mode" : following ? "Following" : "Not following";
}

function SettingsSheet(props: {
  readonly pages: ReadonlyArray<SettingsPage>;
  /** The title of the page it was opened on, or "" for none. */
  readonly section: string;
  /** Saving…, or a save that failed (`failed`), beside the close. */
  readonly status?: string | null;
  readonly failed?: boolean;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const opened = props.pages.find((p) => p.title === props.section)?.id;
  const [page, setPage] = useState(() => opened ?? lastPage(props.pages));
  // A phone shows the list of pages first, unless the sheet was opened on one.
  const [listed, setListed] = useState(opened === undefined);
  const phone = useSyncExternalStore(PHONE_MEDIA.subscribe, isPhone, () => false);
  const rail = useSyncExternalStore(RAIL_MEDIA.subscribe, RAIL_MEDIA.matches, () => false);
  // The sidebar's one Tab stop follows keyboard focus, as T3's tree does.
  const [rove, setRove] = useState<string | null>(null);
  const onList = phone && listed;
  const navRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A step between the phone's list and a page: focus follows to what shows.
  const stepped = useRef(false);
  const titleId = useId();
  const opening = useRef(true);
  const current = props.pages.find((p) => p.id === page) ?? props.pages[0];
  // Opened on a page (the call button's Connection): that page is remembered.
  const rememberOpened = useEffectEvent(() => {
    if (opened) remember(opened);
  });

  const show = (id: string) => {
    setPage(id);
    setListed(false);
    remember(id);
    setRove(null);
    // A phone's hidden page has lost its scroll already; a desktop's is reset here.
    bodyRef.current?.scrollTo({ top: 0 });
    stepped.current = phone;
  };
  const backToList = () => {
    setListed(true);
    stepped.current = true;
  };
  // A phone's page steps back to the list first, as Back would.
  const onEscape = useEffectEvent(() => (phone && !listed ? backToList() : props.onClose()));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus as the sheet opens, after a step between list and page, or when the 640px switch hides it: a phone page's Back, else the current row
  useLayoutEffect(() => {
    const first = opening.current;
    opening.current = false;
    const at = document.activeElement;
    const lost =
      at === document.body ||
      (at instanceof HTMLElement &&
        panelRef.current?.contains(at) === true &&
        at.getClientRects().length === 0);
    if (!first && !stepped.current && !lost) return;
    stepped.current = false;
    // A phone's page: its Back. The phone's list as it opens: the sheet. Otherwise the current row.
    const target =
      phone && !onList
        ? backRef.current
        : first && onList
          ? panelRef.current
          : navRef.current?.querySelector<HTMLElement>(`[data-page="${current?.id}"]`);
    target?.focus({ preventScroll: true });
  }, [phone, onList, current?.id, stepped]);

  // T3's sidebar: one Tab stop, arrows move along it without wrapping.
  const onNavKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? Math.min(at + 1, items.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the newest synced settings while the sheet is open; Esc closes it
  useEffect(() => {
    pullSynced();
    rememberOpened();
    // Esc closes; Tab wraps inside the sheet so focus never reaches the canvas behind it. Not a
    // <dialog>: its top layer would cover the reset buttons' tooltips, which portal to the body.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onEscape();
      const panel = panelRef.current;
      if (event.key !== "Tab" || panel === null) return;
      const stops = [
        ...panel.querySelectorAll<HTMLElement>(
          "a[href], button, input, select, textarea, [tabindex]",
        ),
      ].filter(
        (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0,
      );
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      const at = document.activeElement;
      if (at === edge || at === panel || !panel.contains(at)) {
        event.preventDefault();
        (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-lalala-settings="" onClick={props.onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-lalala-settings-panel=""
        data-view={onList ? "list" : "page"}
        onClick={(event) => event.stopPropagation()}
      >
        <nav
          ref={navRef}
          aria-label="Settings pages"
          data-lalala-settings-nav=""
          onKeyDown={phone ? undefined : onNavKey}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setRove(null);
          }}
        >
          <ul data-lalala-settings-pages="">
            {props.pages.map((p) => {
              const button = {
                type: "button",
                "data-page": p.id,
                "aria-current": p.id === current?.id && !onList ? "page" : undefined,
                tabIndex: phone || p.id === (rove ?? current?.id) ? undefined : -1,
                onFocus: phone ? undefined : () => setRove(p.id),
                onClick: () => show(p.id),
              } as const;
              const content = (
                <>
                  <Glyph d={p.icon} />
                  <span>{p.title}</span>
                  <small>
                    <span data-lalala-settings-sr="">, </span>
                    {p.value}
                  </small>
                  <Glyph d={["m9 18 6-6-6-6"]} />
                </>
              );
              // Only the icon rail names its pages on hover and focus; the button stays mounted either way.
              return (
                <li key={p.id}>
                  <Tooltip disabled={!rail}>
                    <TooltipTrigger render={<button {...button} />}>{content}</TooltipTrigger>
                    <TooltipPopup side="right">{p.title}</TooltipPopup>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </nav>
        <div data-lalala-settings-main="">
          <header>
            <div data-lalala-settings-back="">
              <button
                ref={backRef}
                type="button"
                aria-label="Back to settings"
                onClick={backToList}
              >
                <Glyph d={["m15 18-6-6 6-6"]} />
                Settings
              </button>
            </div>
            <h1>
              <span id={titleId}>Settings</span>
              <span aria-hidden="true">/</span>
              <span>{current?.title}</span>
            </h1>
            <span
              data-lalala-settings-saving=""
              data-failed={props.failed ? "" : undefined}
              aria-live="polite"
            >
              {props.status}
            </span>
            <button type="button" aria-label="Close settings" onClick={props.onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
          {/* Every page stays mounted, so a check or a failed save survives a look at another page. */}
          <div ref={bodyRef} data-lalala-settings-body="">
            {props.pages.map((p) => (
              <div key={p.id} hidden={p.id !== current?.id}>
                {p.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The app's pages: the harness connection, the brain's and new threads' models, sound, canvas. */
function AppSettings(props: { readonly section: string; readonly onClose: () => void }) {
  const [brain, setBrain] = useState<BrainState>({ kind: "loading" });
  const savingRef = useRef(false);
  const brainRevision = useRef(0);
  const retryGroup = useRef<HTMLElement | null>(null);
  const [retrying, setRetrying] = useState(false);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- transfer focus from the retry row only if it still held focus when the request finished
  useLayoutEffect(() => {
    if (brain.kind !== "ready") return;
    retryGroup.current
      ?.querySelector<HTMLElement>("[data-lalala-settings-pick]:not(:disabled)")
      ?.focus({ preventScroll: true });
    retryGroup.current = null;
  }, [brain.kind]);

  const retryBrain = (control?: HTMLButtonElement) => {
    if (savingRef.current || retrying || (brain.kind !== "error" && brain.kind !== "missing"))
      return;
    setRetrying(true);
    const revision = brainRevision.current;
    void fetchBrain().then((next) => {
      setRetrying(false);
      if (revision !== brainRevision.current) return;
      if (next.kind === "ready" && control?.matches(":focus")) {
        retryGroup.current = control.closest("[data-lalala-settings-group]");
      }
      setBrain(next);
    });
  };

  const configureBrain = (selection: Selection) => {
    if (brain.kind !== "ready" && brain.kind !== "error") return;
    const before = brain.brain;
    if (before === null || savingRef.current) return;
    savingRef.current = true;
    brainRevision.current++;
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
      .catch((cause: unknown) => setBrain({ kind: "error", message: String(cause), brain: before }))
      .finally(() => {
        savingRef.current = false;
      });
  };

  const known = brain.kind === "ready" ? brain.brain : brain.kind === "error" ? brain.brain : null;

  const [connection, setConnection] = useState<ConnectionState>({ kind: "loading" });
  const link =
    connection.kind === "inside" || (connection.kind === "ready" && connection.connection.connected)
      ? "Connected"
      : connection.kind === "ready"
        ? "Not connected"
        : "…";
  const selection = known?.modelSelection;
  const brainModel =
    known && selection ? findModel(known, selection.instanceId, selection.model) : undefined;
  const { delegates } = useSyncedSettings();
  const sound = useSoundValue();
  const canvas = useCanvasValue();
  const pages: SettingsPage[] = [
    {
      id: "connection",
      title: "Connection",
      icon: PAGE_ICONS.connection,
      value: link,
      content: (
        <ConnectionSection onChange={() => retryBrain()} onState={setConnection} />
      ),
    },
    {
      id: "brain",
      title: "Voice brain",
      icon: PAGE_ICONS.brain,
      value:
        brain.kind === "error" && brain.brain !== null
          ? "Not saved"
          : (brainModel?.name ?? (brain.kind === "loading" ? "…" : "Unavailable")),
      content: (
        <BrainSection
          state={brain}
          onConfigure={configureBrain}
          retrying={retrying}
          onRetry={retryBrain}
        />
      ),
    },
    {
      id: "threads",
      title: "New threads",
      icon: PAGE_ICONS.threads,
      value: delegates.model === null ? "Same as the brain" : (delegates.modelName ?? "Custom"),
      content: <ThreadsSection brain={known} loading={brain.kind === "loading" || retrying} />,
    },
    {
      id: "sound",
      title: "Sound & mic",
      icon: PAGE_ICONS.sound,
      value: sound,
      content: <SoundSection />,
    },
    {
      id: "canvas",
      title: "Canvas",
      icon: PAGE_ICONS.canvas,
      value: canvas,
      content: <CanvasRows />,
    },
  ];

  // A save that failed shows beside the close too, so it is seen from any page.
  const failed = brain.kind === "error" && brain.brain !== null;
  return (
    <SettingsSheet
      pages={pages}
      section={props.section}
      status={
        brain.kind === "ready" && brain.saving ? "Saving…" : failed ? "Voice brain not saved" : null
      }
      failed={failed}
      onClose={props.onClose}
    />
  );
}

/** A page's one section, its title for screen readers only (the header shows it), as T3's hideTitle. */
export function Section(props: {
  readonly title: string;
  readonly ungrouped?: boolean;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
}) {
  const id = useId();
  const content = (
    <>
      {props.note ? <p data-lalala-settings-info="">{props.note}</p> : null}
      {props.children}
    </>
  );
  return (
    <section data-lalala-settings-section="" aria-labelledby={id}>
      <h2 id={id} data-lalala-settings-sr="">
        {props.title}
      </h2>
      {props.ungrouped ? (
        content
      ) : props.note || props.children ? (
        <div data-lalala-settings-group="">{content}</div>
      ) : null}
    </section>
  );
}

/**
 * T3 Code's settings row; `onReset` shows its reset button beside the title (when not the default).
 * A function child gets the description's id for its control's aria-describedby.
 */
export function Row(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly onReset?: (() => void) | undefined;
  readonly error?: boolean;
  readonly children: ReactNode | ((describedBy: string | undefined) => ReactNode);
}) {
  const id = useId();
  const describedBy = props.description ? id : undefined;
  const controlRef = useRef<HTMLDivElement>(null);
  return (
    <div data-lalala-settings-row="">
      <div>
        <div data-lalala-settings-title="">
          <h3>{props.title}</h3>
          {props.onReset ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Reset ${props.title} to default`}
                    data-lalala-settings-reset=""
                    onClick={() => {
                      controlRef.current
                        ?.querySelector<HTMLElement>("[data-lalala-settings-pick], input")
                        ?.focus({ preventScroll: true });
                      props.onReset?.();
                    }}
                  />
                }
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                </svg>
              </TooltipTrigger>
              <TooltipPopup side="top">Reset to default</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {props.description ? (
          <p
            id={id}
            role={props.error ? "alert" : undefined}
            data-lalala-settings-error={props.error ? "" : undefined}
          >
            {props.description}
          </p>
        ) : null}
      </div>
      <div ref={controlRef} data-lalala-settings-control="">
        {typeof props.children === "function" ? props.children(describedBy) : props.children}
      </div>
    </div>
  );
}

function Toggle(props: {
  readonly on: boolean;
  readonly label: string;
  readonly describedBy: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      aria-disabled={props.busy || undefined}
      data-lalala-settings-switch=""
      onClick={() => {
        if (!props.busy) props.onChange(!props.on);
      }}
    >
      <span />
    </button>
  );
}

type PickOption = {
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
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

/** A picker anchored under its trigger, with listbox keyboard navigation. */
export function PickRow(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly groups: ReadonlyArray<PickGroup>;
  readonly disabled?: boolean | undefined;
  readonly onReset?: (() => void) | undefined;
  /** Plays a playable option: from its button, and as the keyboard moves onto it. */
  readonly onPlay?: (value: string) => void;
  readonly busy?: boolean | undefined;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options = props.groups.flatMap((group) => group.options);
  const selected = options.findIndex((option) => option.value === props.value);
  const optionId = (index: number) => `${id}o${index}`;
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const dismiss = useEffectEvent(close);

  const listRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus and reveal the popup on open, and dismiss pointer clicks outside its control
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!open || !node) return;
    node.focus({ preventScroll: true });
    node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    node.scrollIntoView({ block: "nearest" });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !node.parentElement?.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== "pointerdown") dismiss();
      }
    };
    const events = ["pointerdown", "touchstart", "click"];
    for (const type of events)
      document.addEventListener(type, outside, { capture: true, passive: false });
    return () => {
      for (const type of events) document.removeEventListener(type, outside, true);
    };
  }, [open]);

  const show = () => {
    setActive(Math.max(selected, 0));
    setOpen(true);
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option && option.value !== props.value && !props.busy) {
      props.onChange(option.value);
    }
    close();
  };
  const move = (index: number) => {
    const next = Math.min(Math.max(index, 0), options.length - 1);
    const option = options[next];
    if (option === undefined) return;
    setActive(next);
    if (option.playable) props.onPlay?.(option.value);
    // Only scrolls when the option is out of view; moving up onto a group's first option shows its title.
    const el = document.getElementById(optionId(next));
    const title = next < active ? el?.previousElementSibling : null;
    (title?.hasAttribute("aria-hidden") ? title : el)?.scrollIntoView({ block: "nearest" });
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
    else if (event.key === "Tab") {
      // From the trigger, so Tab carries on to the next control instead of restarting the sheet.
      return close();
    } else return;
    event.preventDefault();
  };

  return (
    <Row title={props.title} description={props.description} onReset={props.onReset}>
      {(describedBy) => (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? `${id}l` : undefined}
            aria-label={`${props.label}: ${options[selected]?.label ?? "none"}`}
            aria-describedby={describedBy}
            disabled={props.disabled}
            aria-disabled={props.busy || undefined}
            data-lalala-settings-pick=""
            data-open={open ? "" : undefined}
            onClick={() => !props.busy && (open ? close() : show())}
            onKeyDown={(event) => {
              if (props.busy || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp"))
                return;
              event.preventDefault();
              show();
            }}
          >
            <span>
              <PickLabel option={options[selected]} />
            </span>
            {!props.disabled ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            ) : null}
          </button>
          {open ? (
            <div
              ref={listRef}
              role="listbox"
              id={`${id}l`}
              aria-label={props.label}
              aria-activedescendant={optionId(active)}
              tabIndex={-1}
              data-lalala-settings-list=""
              onKeyDown={onListKey}
            >
              {props.groups.map((group, groupIndex) => (
                <div key={group.label ?? groupIndex} role="group" aria-label={group.label}>
                  {group.label ? <div aria-hidden="true">{group.label}</div> : null}
                  {group.options.map((option) => {
                    const at = options.indexOf(option);
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
                          {option.detail ? <small> · {option.detail}</small> : null}
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
          ) : null}
        </>
      )}
    </Row>
  );
}

/** One row per option the model offers (reasoning, fast mode, …), in T3's own words. */
function OptionRows(props: {
  readonly model: Model | undefined;
  readonly values: Record<string, OptionValue>;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly onChange: (id: string, value: OptionValue) => void;
}) {
  return (props.model?.options ?? []).map((d) =>
    d.type === "boolean" ? (
      <Row key={d.id} title={d.label} description={d.description}>
        {(describedBy) => (
          <Toggle
            on={valueOf(d, props.values[d.id]) === true}
            label={d.label}
            describedBy={describedBy}
            disabled={props.disabled}
            busy={props.busy}
            onChange={(on) => props.onChange(d.id, on)}
          />
        )}
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
        busy={props.busy}
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
    return `Answered in ${ms ?? "?"} ms`;
  });
const describe = (cause: unknown) => {
  const message = (cause instanceof Error ? cause.message : String(cause)).replace(/^T3: /, "");
  return /token exchange answered 40[01]/.test(message)
    ? "That pairing link was already used or expired. Make a new one in T3 Code."
    : message;
};

/**
 * The harness the voice works through: T3 Code today, the one the app's bridge pairs with. Paste a
 * pairing link and it pairs, checks the link and shows it connected; nothing else to click.
 */
function ConnectionSection(props: {
  readonly onChange: () => void;
  /** Every new reading, for the Connection row's value in the phone's list. */
  readonly onState?: (state: ConnectionState) => void;
}) {
  const [state, setRawState] = useState<ConnectionState>({ kind: "loading" });
  const setState = (next: ConnectionState) => {
    setRawState(next);
    props.onState?.(next);
  };
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);

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
    setChecked(null);
    void work()
      .catch((cause: unknown) => {
        setChecked(null);
        setProblem(describe(cause));
      })
      .then(fetchConnection)
      .then((next) => {
        setState(next);
        setWorking(null);
      });
  };

  /** Pairs, then checks the link: T3 Code answering is what makes it Connected. */
  const pair = (body: object) =>
    run("Pairing with T3 Code…", async () => {
      const result = (await sendConnection("/pair", body)) as unknown as Connection;
      if (!result.connected)
        throw new Error(result.error?.replace(/^T3: /, "") ?? "T3 Code did not answer. Is it running?");
      setWorking("Checking the connection…");
      await check();
      props.onChange();
    });

  const title = "Connection";
  if (state.kind === "loading") return <Section title={title} note="Reading the connection…" />;
  if (state.kind === "inside") {
    return (
      <Section title={title} note="The voice runs inside T3 Code, so it is always connected." />
    );
  }
  const c = state.connection;

  if (!c.paired) {
    return (
      <Section title={title}>
        <PairSteps
          reach="server"
          label="lalala"
          command={PAIR_COMMAND}
          working={working}
          problem={problem}
          onPair={(input) => {
            try {
              // A bare code is for the T3 the app's server already talks to, whatever its port.
              pair(isPairingCode(input) ? { code: input.trim() } : { link: pairingLink(input) });
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
    <Section title={title}>
      {c.notice ? <p data-lalala-settings-info="">{c.notice}</p> : null}
      <ConnectedRows
        ok={c.connected && problem === null}
        where={[c.server ? `${c.server.label} · v${c.server.version}` : null, c.origin]
          .filter(Boolean)
          .join(" · ")}
        checked={working ?? checked}
        problem={problem ?? error}
        expiresAt={c.session?.expiresAt ?? null}
        renews={c.session?.renews}
        busy={working !== null}
        onRetest={() => run("Checking…", () => check().finally(props.onChange))}
        onDisconnect={() => run("Disconnecting…", () => sendConnection("/disconnect"))}
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
  readonly retrying: boolean;
  readonly onRetry: (control: HTMLButtonElement) => void;
}) {
  const { state } = props;
  const title = "Voice brain";
  if (state.kind === "loading") return <Section title={title} note="Reading T3…" />;
  if (state.kind === "missing") {
    return (
      <Section
        title={title}
        note="The brain's model is set here in the voice app. In T3 Code, use the voice thread's model picker."
      >
        <BrainContextRow />
      </Section>
    );
  }
  const brain = state.brain;
  const error = state.kind === "error" ? state.message : null;
  if (brain === null)
    return (
      <Section title={title}>
        <Row
          title="Couldn't read T3"
          description={<StreamerText text={error ?? "T3 did not answer"} />}
          error
        >
          <button
            type="button"
            data-lalala-settings-button=""
            data-quiet=""
            aria-disabled={props.retrying || undefined}
            onClick={(event) => props.onRetry(event.currentTarget)}
          >
            {props.retrying ? "Reading T3…" : "Try again"}
          </button>
        </Row>
      </Section>
    );
  const selection = brain.modelSelection;
  const model = selection ? findModel(brain, selection.instanceId, selection.model) : undefined;
  const values = carryOptions(model, optionMap(selection));
  const saving = state.kind === "ready" && state.saving;

  return (
    <Section title={title}>
      {error ? (
        <p data-lalala-settings-error="" role="alert">
          <StreamerText text={error} />
        </p>
      ) : null}
      <PickRow
        title="Model"
        description="The thread you talk to. Changes apply from its next turn, on every device."
        label="Voice brain model"
        groups={modelGroups(brain.providers)}
        value={selection ? modelKey(selection.instanceId, selection.model) : ""}
        busy={saving}
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
        disabled={selection === null}
        busy={saving}
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
      <BrainContextRow />
    </Section>
  );
}

/** The brain's context size; a big one compacts when the user comes back (VoiceHost). */
function BrainContextRow() {
  const context = useVoiceBrainContext(useSharedBrainThread());
  if (context === null || !context.claude) return null;
  return (
    <Row
      title="Context"
      description="Over 200k after a pause, it tidies up its memory before your next words."
    >
      <span data-lalala-settings-value="">
        {context.compacting
          ? "Tidying up…"
          : `${formatTokens(context.usedTokens)}${context.maxTokens ? ` of ${formatTokens(context.maxTokens)}` : ""} tokens`}
      </span>
    </Row>
  );
}

const THREAD_MODEL_NOTE =
  "What the brain gives the threads it delegates to. Sent with each message, on every device.";

function ThreadsSection(props: { readonly brain: Brain | null; readonly loading: boolean }) {
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
  const newModel =
    delegates.model === null || delegates.instanceId === null
      ? ""
      : modelKey(delegates.instanceId, delegates.model);
  const pickNew = (key: string) => {
    if (key === "") {
      return set({
        instanceId: null,
        model: null,
        modelName: null,
        options: carryOptions(brainModel, delegates.options),
      });
    }
    const { instanceId, slug } = splitKey(key);
    const nextModel = brain ? findModel(brain, instanceId, slug) : undefined;
    set({
      instanceId,
      model: slug,
      modelName: nextModel?.name ?? null,
      options: carryOptions(nextModel, delegates.options),
    });
  };

  return (
    <Section title="New threads">
      {brain || props.loading ? (
        <PickRow
          title="Model"
          description={THREAD_MODEL_NOTE}
          label="Model for new threads"
          groups={[
            {
              options: [
                {
                  value: "",
                  label: brain ? "Same as the brain" : "Loading…",
                  detail: brainModel?.name,
                },
              ],
            },
            ...modelGroups(brain?.providers ?? []),
          ]}
          value={brain ? newModel : ""}
          disabled={!brain}
          onReset={!brain || newModel === "" ? undefined : () => pickNew("")}
          onChange={(key) => pickNew(key)}
        />
      ) : (
        // The brain failed to load: a plain value like the option rows below, not a dead picker.
        <Row title="Model" description={THREAD_MODEL_NOTE}>
          <span data-lalala-settings-value="">{delegates.modelName ?? "Unavailable"}</span>
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
          <Row key={id} title={OPTION_TITLES[id] ?? id}>
            <span data-lalala-settings-value="">{optionText(value)}</span>
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
                label: `${soundTitle(DEFAULT_TOPIC_SOUND)} (default)`,
                playable: true,
              },
              ...names
                .filter((name) => name !== DEFAULT_TOPIC_SOUND)
                .map((name) => ({ value: name, label: soundTitle(name), playable: true })),
            ],
          },
        ]}
        onPlay={playTopicSound}
        onReset={
          topicSound === DEFAULT_TOPIC_SOUND
            ? undefined
            : () => updateSynced({ topicSound: DEFAULT_TOPIC_SOUND })
        }
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
        onReset={mic === null ? undefined : () => setMicDeviceId(null)}
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
  const id = useId();
  return (
    <Row
      title="Sounds volume"
      description="Every sound but the voice: the topic sound, call chimes, card samples and games."
      onReset={percent === 100 ? undefined : () => setSoundVolume(1)}
    >
      {(describedBy) => (
        <div data-lalala-settings-slider="">
          <output htmlFor={id}>{percent}%</output>
          <input
            id={id}
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-label="Sounds volume"
            aria-describedby={describedBy}
            style={{ "--value": percent } as CSSProperties}
            onChange={(event) => setSoundVolume(Number(event.currentTarget.value) / 100)}
          />
        </div>
      )}
    </Row>
  );
}

export function CanvasRows() {
  const following = useSyncExternalStore(subscribeFollow, isFollowing, () => false);
  const streamer = useStreamerMode();
  return (
    <Section title="Canvas">
      <Row
        title="Follow the voice"
        description="The canvas moves to the cards the voice talks about. Also the Follow tab, or say “follow”."
      >
        {(describedBy) => (
          <Toggle
            on={following}
            label="Follow the voice"
            describedBy={describedBy}
            onChange={setFollowing}
          />
        )}
      </Row>
      <Row
        title="Streamer mode"
        description="Scrambles thread titles and message text, for screen sharing."
      >
        {(describedBy) => (
          <Toggle
            on={streamer}
            label="Streamer mode"
            describedBy={describedBy}
            onChange={(on) => {
              try {
                localStorage.setItem(STREAMER_KEY, on ? "on" : "off");
              } catch {
                return;
              }
              window.dispatchEvent(new Event(STREAMER_KEY));
            }}
          />
        )}
      </Row>
    </Section>
  );
}
