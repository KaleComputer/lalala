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
import { connectPreview, TALK_CONNECT_COMMAND, TALK_PAIR_COMMAND } from "./connectPreview";
import { isFollowing, setFollowing, subscribeFollow } from "./follow";
import { isPairingCode, pairingLink } from "./pairing";
import { setStreamerMode, StreamerText, useStreamerMode } from "./streamerMode";
import { topicChime } from "./player";
import {
  BUILT_IN_TOPIC_SOUND,
  DEFAULT_TOPIC_SOUND,
  type Delegates,
  type OptionValue,
  pullSynced,
  setMicDeviceId,
  setReplyVoice,
  defaultReplyVoice,
  isPhoneDevice,
  setAutoRetrySeconds,
  setAutoStartCall,
  setSttModel,
  AUTO_RETRY_CHOICES,
  DEFAULT_AUTO_RETRY_SECONDS,
  topicSoundNames,
  topicSoundUrl,
  updateSynced,
  useMicDeviceId,
  useAutoRetrySeconds,
  useAutoStartCall,
  useReplyVoicePick,
  useSttModel,
  type SttModel,
  useSyncedSettings,
} from "./settingsStore";
import { replyVoicePlugins, subscribeReplyVoices } from "./replyVoices";
import {
  browserFaster,
  checkGpu,
  automaticTriesComputer,
  computerSpeechSince,
  speechRunsAt,
  computerSpeechState,
  NEEDS_WEBGPU,
  activeSpeech,
  type ActiveSpeech,
  computerSpeechReason,
  speechTimings,
  tryingComputer,
  refreshComputerSpeech,
  speechStateVersion,
  speechStatus,
  subscribeSpeechState,
} from "./browserSpeech/browser";
import { viaT3 } from "./browserSpeech/computerRoute";
import { useLook } from "./extras/look";
import { VersionLabel } from "./VersionLabel";
import { ThemeGallery } from "./extras/ThemeGallery";
import { setSoundVolume, soundOutput, useSoundVolume, withSoundVolume } from "./extras/soundVolume";
import { REQUEST_TIMEOUT_MS } from "./voiceErrors";
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
export type Brain = {
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
  const speech = useSpeechSummary();
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
          data-lalala-tab=""
          data-open={open ? "" : undefined}
          aria-expanded={open}
          aria-label="Voice settings"
          title={`Voice settings · hears: ${speech.hears} · speaks: ${speech.speaks}`}
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
            // The page's body, or the states card's frame for a preview bar (extras/BarStates).
            props.tabHost.ownerDocument.body,
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
export const onVoiceSettingsClosed = (listener: () => void): (() => void) =>
  subscribeOpen(() => {
    if (openAt === null) listener();
  });

const fetchBrain = () =>
  fetch(BRAIN_ROUTE, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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
  themes: [
    "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22z",
    "M7.5 10.5h.01",
    "M12 7.5h.01",
    "M16.5 10.5h.01",
  ],
  canvas: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
  cards: ["M12 2 2 7l10 5 10-5-10-5z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  startup: ["M12 2v10", "M18.4 6.6a9 9 0 1 1-12.77.04"],
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

/** Whether the canvas follows the voice, beside Canvas in the phone's list. */
export function useCanvasValue(): string {
  const following = useSyncExternalStore(subscribeFollow, isFollowing, () => false);
  return following ? "Following the voice" : "Not following";
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
  const [listed, setListed] = useState(() => opened === undefined && isPhone());
  const phone = useSyncExternalStore(PHONE_MEDIA.subscribe, isPhone, () => false);
  const rail = useSyncExternalStore(RAIL_MEDIA.subscribe, RAIL_MEDIA.matches, () => false);
  // The sidebar's one Tab stop follows keyboard focus, as T3's tree does.
  const [rove, setRove] = useState<string | null>(null);
  const onList = phone && listed;
  const navRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The view focus was last placed for (phone, list or page, which page): a new one gets focus.
  const focusedView = useRef<string | null>(null);
  const titleId = useId();
  const pageNameId = useId();
  const current = props.pages.find((p) => p.id === page) ?? props.pages[0];

  const show = (id: string) => {
    if (id === current?.id && !onList) return;
    setPage(id);
    setListed(false);
    setRove(null);
    // A phone's hidden page has lost its scroll already; a desktop's is reset here.
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const backToList = () => setListed(true);
  // A phone's page steps back to the list first, as Back would.
  const onEscape = useEffectEvent(() => (phone && !listed ? backToList() : props.onClose()));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each new view (opening, a step between list and page, a page, the 640px switch) is remembered and, unless a showing control holds it, gets focus
  useLayoutEffect(() => {
    const view = `${phone}/${onList}/${current?.id}`;
    const first = focusedView.current === null;
    if (view === focusedView.current) return;
    focusedView.current = view;
    if (!onList && current) remember(current.id);
    // A control still showing keeps focus (a resize); a hidden one or none: a phone page's Back, the phone's list as it
    // opens the sheet (named Settings), else the page's row.
    const panel = panelRef.current;
    const at = document.activeElement;
    if (at && at !== panel && panel?.contains(at) && at.getClientRects().length > 0) return;
    const target =
      phone && !onList
        ? backRef.current
        : onList && first
          ? panel
          : navRef.current?.querySelector<HTMLElement>(`[data-page="${current?.id}"]`);
    if (target !== at) target?.focus({ preventScroll: true });
  }, [phone, onList, current?.id]);

  // T3's sidebar: one Tab stop, arrows move along it without wrapping.
  const onNavKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>("button[data-page]") ?? [])];
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
        data-rail={rail ? "" : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div data-lalala-settings-back="">
            <button
              ref={backRef}
              type="button"
              aria-label="Back to settings"
              aria-describedby={pageNameId}
              onClick={backToList}
            >
              <Glyph d={["m15 18-6-6 6-6"]} />
              Settings
            </button>
          </div>
          <h1 id={titleId}>
            <span>Settings</span>
            <span>
              <span aria-hidden="true">/</span>
              <span data-lalala-settings-sr="">, </span>
            </span>
            <span id={pageNameId}>{current?.title}</span>
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
                // The current row is the stop already; only another row moves it.
                onFocus: () => (rove !== null || p.id !== current?.id) && setRove(p.id),
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
          <VersionLabel />
        </nav>
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
  );
}

export const LOOK_NAMES = { neon: "Cyberpunk", paper: "Paper notebook", t3: "T3 Code" } as const;

/** Themes: the look of the canvas, its cards, the device bar and these settings, on this device. */
export function ThemeSection() {
  return (
    <Section
      title="Themes"
      ungrouped
      note={
        <>
          Changes the whole look on this device. If a theme ever breaks the page, add{" "}
          <code>?look=neon</code> to the address.
        </>
      }
    >
      <ThemeGallery />
    </Section>
  );
}

/** The app's pages: the harness connection, the brain's and new threads' models, sound, themes, canvas. */
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
  const link = connectPreview
    ? "Not connected"
    : connection.kind === "inside" || (connection.kind === "ready" && connection.connection.connected)
      ? "Connected"
      : connection.kind === "ready"
        ? "Not connected"
        : "…";
  const selection = known?.modelSelection;
  const brainModel =
    known && selection ? findModel(known, selection.instanceId, selection.model) : undefined;
  const { delegates } = useSyncedSettings();
  const speechLine = useSpeechSummary().line;
  const canvas = useCanvasValue();
  const autoStart = useAutoStartCall();
  const look = useLook();
  const pages: SettingsPage[] = [
    {
      id: "connection",
      title: "Connection",
      icon: PAGE_ICONS.connection,
      value: link,
      content: (
        connectPreview ? (
          <ConnectPreview />
        ) : (
          <ConnectionSection onChange={() => retryBrain()} onState={setConnection} />
        )
      ),
    },
    {
      id: "startup",
      title: "Startup",
      icon: PAGE_ICONS.startup,
      value: autoStart ? "Starts by itself" : "Starts when you press Start",
      content: <OpeningSection />,
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
      value: speechLine,
      content: (
        <>
          <SoundSection />
          <SpeechSection />
          <CreditsSection />
        </>
      ),
    },
    {
      id: "themes",
      title: "Themes",
      icon: PAGE_ICONS.themes,
      value: LOOK_NAMES[look],
      content: <ThemeSection />,
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

/**
 * A page's section. Its title is for screen readers only (the header shows the page's name) unless
 * `about` is given: then a page with several groups names this one and says what it is for. `fine`
 * makes the note small print under the page instead of a group of its own.
 */
export function Section(props: {
  readonly title: string;
  /** Shows the title, for a page with several groups; a title gives direction, so no line under it. */
  readonly named?: boolean;
  readonly ungrouped?: boolean;
  readonly fine?: boolean;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
}) {
  const id = useId();
  const content = props.fine ? (
    <p data-lalala-settings-fine="">{props.note}</p>
  ) : (
    <>
      {props.note ? <p data-lalala-settings-info="">{props.note}</p> : null}
      {props.children}
    </>
  );
  return (
    <section data-lalala-settings-section="" aria-labelledby={id}>
      {props.named ? (
        <header data-lalala-settings-heading="">
          <h2 id={id}>{props.title}</h2>
        </header>
      ) : (
        <h2 id={id} data-lalala-settings-sr="">
          {props.title}
        </h2>
      )}
      {props.ungrouped || props.fine ? (
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
  /** A second line under the label, in the same small box on every option (a clip's length). */
  readonly meta?: string | undefined;
  /** The row gets a play button (onPlay). */
  readonly playable?: boolean;
  /** The label can identify the user (a device name, a project title): streamer mode scrambles it. */
  readonly hidden?: boolean;
  /** Listed with its reason (in `meta`) but can't be picked here. */
  readonly disabled?: boolean | undefined;
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

/** Lengths of the extras/topicSounds-*.mp3 files (ffprobe); a sound missing here sorts last with no length. */
const TOPIC_SOUND_SECONDS: Readonly<Record<string, number>> = {
  "double-blip": 0.48,
  "glass-tick": 0.48,
  "wood-knock": 0.48,
  "arcade-coin": 0.6,
  "soft-ping": 0.6,
  "neon-zap": 0.68,
  "marimba-up": 0.8,
  "page-swipe": 0.8,
  "cyber-glitch": 0.88,
  "new-topic": 1.08,
  "swoosh-hit": 1.2,
  "next-up": 1.23,
  meanwhile: 1.28,
  "breaking-whoosh": 1.36,
  "news-sting": 1.76,
  "newsroom-pulse": 1.76,
  "wind-chimes": 1.76,
  "singing-bowl": 2.04,
  "pad-swell": 2.2,
  "and-now": 2.48,
};

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
  /** What the picked option runs right now, after its name in the closed select (Automatic's pick). */
  readonly shows?: string | undefined;
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
    // The list fits the settings page it sits in: below its trigger, or above it when there is more room
    // there (the page's end); measured before anything scrolls, then the chosen option is revealed.
    node.style.maxHeight = "";
    delete node.dataset.above;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const page = node.closest("[data-lalala-settings-body]")?.getBoundingClientRect();
    if (trigger && page) {
      const below = Math.min(window.innerHeight, page.bottom) - trigger.bottom - 14;
      const above = trigger.top - Math.max(0, page.top) - 14;
      if (node.offsetHeight > below && above > below) node.dataset.above = "";
      const room = Math.max(above, below);
      if (node.offsetHeight > room) node.style.maxHeight = `${room}px`;
    }
    node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
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
    if (option?.disabled) return;
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
            aria-label={`${props.label}: ${options[selected]?.label ?? "none"}${
              options[selected]?.detail ? `, ${options[selected].detail}` : ""
            }${options[selected]?.disabled ? `, ${options[selected].meta ?? "unavailable"}` : ""}${
              props.shows ? `, now ${props.shows}` : ""
            }`}
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
              {props.shows ? <small data-lalala-settings-shows="">{` · ${props.shows}`}</small> : null}
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
                        aria-disabled={option.disabled || undefined}
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
                          {option.meta ? (
                            <span data-lalala-settings-meta="">{option.meta}</span>
                          ) : null}
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
  fetch(CONNECTION_ROUTE, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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

const PAIR_COMMAND = "npx t3 pair --label lalala";
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
/** `?connect=fresh`: lalala.talk's connect screen as a visitor sees it before pairing; pairs nothing. */
function ConnectPreview() {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Section title="Connection">
      <PairSteps
        command={TALK_PAIR_COMMAND}
        connectCommand={TALK_CONNECT_COMMAND}
        working={null}
        problem={problem}
        onPair={() =>
          setProblem("Preview (?connect=fresh): nothing pairs here, the real connection is untouched.")
        }
      />
    </Section>
  );
}

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
  // It compacts only once its prompt cache has run out, so with the 1-hour cache that is an hour of quiet.
  const pause = context.cacheTtlMs ?? 5 * 60_000;
  const quiet =
    pause >= 3_600_000 ? `${Math.round(pause / 3_600_000)} h` : `${Math.round(pause / 60_000)} min`;
  return (
    <Row
      title="Context"
      description={`Over 200k, it compacts its thread before your next words once it has been quiet for ${quiet}, when its prompt cache has run out.`}
    >
      <span data-lalala-settings-value="">
        {context.compacting
          ? "Compacting…"
          : `${formatTokens(context.usedTokens)}${context.maxTokens ? ` of ${formatTokens(context.maxTokens)}` : ""} tokens`}
      </span>
    </Row>
  );
}

const THREAD_MODEL_NOTE =
  "What the brain gives the threads it delegates to. Sent with each message, on every device.";

export function ThreadsSection(props: {
  readonly brain: Brain | null;
  readonly loading: boolean;
}) {
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
    <Section title="Sounds and microphone" named>
      <PickRow
        title="Update sound"
        description="Plays before an update, like a thread's result (not for one about the card you're looking at)."
        label="Update sound"
        value={topicSound}
        groups={[
          {
            options: [
              { value: "none", label: "None" },
              { value: BUILT_IN_TOPIC_SOUND, label: "Chime (built in)", playable: true },
              ...names
                .toSorted(
                  (a, b) =>
                    (TOPIC_SOUND_SECONDS[a] ?? Infinity) - (TOPIC_SOUND_SECONDS[b] ?? Infinity),
                )
                .map((name) => {
                  const seconds = TOPIC_SOUND_SECONDS[name];
                  return {
                    value: name,
                    label:
                      name === DEFAULT_TOPIC_SOUND
                        ? `${soundTitle(name)} (default)`
                        : soundTitle(name),
                    meta: seconds === undefined ? undefined : `${seconds.toFixed(1)} s`,
                    playable: true,
                  };
                }),
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

type BrowserEars = Exclude<SttModel, "auto" | "computer">;
type VoiceBuild = "kokoro-gpu" | "kokoro-cpu" | "matcha" | "computer";
const STT_LABELS: Record<Exclude<SttModel, "auto">, string> = {
  "0.6b-gpu": "Parakeet 0.6B\u00a0·\u00a0GPU",
  "0.6b-cpu": "Parakeet 0.6B\u00a0·\u00a0CPU",
  "110m": "Parakeet 110M",
  computer: "Parakeet 0.6B\u00a0·\u00a0Computer",
};
const VOICE_LABELS: Record<VoiceBuild, string> = {
  "kokoro-gpu": "Kokoro 82M\u00a0·\u00a0GPU",
  "kokoro-cpu": "Kokoro 82M\u00a0·\u00a0CPU",
  matcha: "Llama Matcha (Kale's voice)",
  computer: "Kokoro 82M\u00a0·\u00a0Computer",
};
const STT_COSTS: Partial<Record<string, string>> = {
  "0.6b-gpu": "1.25 GB download · ~1.3 GB memory",
  "0.6b-cpu": "661 MB download · ~0.8 GB memory",
  "110m": "137 MB download · ~0.25 GB memory",
};
const VOICE_COSTS: Partial<Record<string, string>> = {
  "kokoro-gpu": "327 MB download · ~0.4 GB memory",
  "kokoro-cpu": "93 MB download · ~0.2 GB memory",
  matcha: "45 MB download · ~0.1 GB memory",
};
const MB = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)}\u00a0GB` : `${Math.round(bytes / 1e6)}\u00a0MB`;

/** What this browser's GPU can run; asked once when the page opens. */
function useGpu() {
  const [gpu, setGpu] = useState<{ f16: boolean; any: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the browser for its GPU adapter once
  useEffect(() => {
    let live = true;
    void checkGpu().then((found) => live && setGpu(found));
    return () => {
      live = false;
    };
  }, []);
  return gpu;
}

const CHECKING = "checking this browser";

/** What the computer option says in the list, per state. */
const COMPUTER_COPY = {
  checking: { meta: "Checking…" },
  ready: { meta: "Nothing downloads here" },
  off: { meta: "Your computer downloads ~2.6 GB once" },
  starting: { meta: "Starting…" },
  loading: { meta: "Loading its models…" },
  down: { meta: "Couldn't start yet, still trying" },
  absent: { meta: "Connect T3 Code first (Connection)" },
} as const;

/** The live line while your computer is being tried, per state. */
const COMPUTER_LIVE = {
  checking: "Checking your computer…",
  off: "Asking your computer…",
  starting: "Starting the speech service on your computer…",
  loading: "Your computer is loading its speech models…",
  ready: "",
  down: "",
  absent: "",
} as const;

/** The workers' own names for what they load, as Settings call them. */
const LOADED_NAMES: Record<string, string> = {
  "parakeet 0.6b gpu": "Parakeet 0.6B\u00a0·\u00a0GPU",
  "parakeet 0.6b": "Parakeet 0.6B\u00a0·\u00a0CPU",
  "parakeet 110m": "Parakeet 110M",
  "kokoro 82m gpu": "Kokoro 82M\u00a0·\u00a0GPU",
  "kokoro 82m cpu": "Kokoro 82M\u00a0·\u00a0CPU",
  "llama matcha": "Llama Matcha (Kale's voice)",
  "parakeet 0.6b mlx": "Parakeet 0.6B",
  "kokoro 82m mlx": "Kokoro 82M",
};
const loadedName = (name: string) => LOADED_NAMES[name] ?? name;
/** The workers' names for the browser builds, as the cost tables key them. */
const LOADED_KEYS: Record<string, string> = {
  "parakeet 0.6b gpu": "0.6b-gpu",
  "parakeet 0.6b": "0.6b-cpu",
  "parakeet 110m": "110m",
  "kokoro 82m gpu": "kokoro-gpu",
  "kokoro 82m cpu": "kokoro-cpu",
  "llama matcha": "matcha",
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 100 ? 2 : 1)} s`;
/** How fast your computer did a task, as measured from this device, once it has. */
function measuredComputer(task: "stt" | "voice"): string | undefined {
  const computer = speechTimings()[task].computer;
  return computer === undefined ? undefined : `measured ${seconds(computer)} per second of audio`;
}

/** What Automatic measured here, per second of audio, once both paths have run on this device. */
function measuredMeta(task: "stt" | "voice"): string | undefined {
  const { browser, computer } = speechTimings()[task];
  return browser !== undefined && computer !== undefined
    ? `Measured per second: computer ${seconds(computer)} · here ${seconds(browser)}`
    : undefined;
}

/** Automatic's line in the list, from the same decision the runtime makes. */
function automaticOption(
  task: "stt" | "voice",
  computer: ReturnType<typeof computerSpeechState>,
  browser: { readonly label: string; readonly cost: string | undefined },
  standIn: { readonly label: string; readonly cost: string | undefined },
) {
  const measured = measuredMeta(task);
  if (computer === "absent") return { detail: browser.label, meta: browser.cost };
  if (browserFaster(task)) {
    // Named from what this browser actually loaded (a stand-in or a storage step-down), as "Now:" says.
    const active = activeSpeech(task);
    const loaded = active.where === "browser" ? active.status.name : null;
    const key = loaded === null ? undefined : LOADED_KEYS[loaded];
    return {
      detail: `${loaded === null ? browser.label : loadedName(loaded)}, faster here than your computer`,
      meta: [measured, key === undefined ? browser.cost : (STT_COSTS[key] ?? VOICE_COSTS[key])]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return {
    detail: `your computer, else ${standIn.label}`,
    meta:
      computer === "ready"
        ? measured === undefined
          ? "Nothing downloads while your computer answers"
          : `${measured} · nothing downloads`
        : `Only while your computer is out: ${standIn.cost ?? standIn.label}`,
  };
}

/** What hears and what speaks right now, and where: the settings tab's tooltip and Sound & mic's line. */
export function useSpeechSummary() {
  useSyncExternalStore(subscribeSpeechState, speechStateVersion, speechStateVersion);
  useSttModel();
  useReplyVoicePick();
  const where = (task: "stt" | "voice") => {
    const active = activeSpeech(task);
    return active.where === "computer" ? "on your computer" : active.where === "card" ? "from a card" : "here";
  };
  const hears = `${runningName("stt", "Parakeet")} ${where("stt")}`;
  const speaks = `${runningName("voice", "Kokoro")} ${where("voice")}`;
  return { hears, speaks, line: `${runningName("voice", "Kokoro")} · ${runningName("stt", "Parakeet")}` };
}

/** The model a task runs on now, short, for Automatic's closed select: "Kokoro 82M · GPU". */
function runningName(task: "stt" | "voice", planned: string): string {
  const active = activeSpeech(task);
  const name =
    active.where === "computer"
      ? active.name
      : active.where === "browser" && active.status.name !== null
        ? active.status.name
        : null;
  return (name === null ? planned : loadedName(name)).replace(" (Kale's voice)", "");
}
/** The same without its build: the closed select has room for the model, "Now:" says GPU or CPU. */
const modelOnly = (name: string) => name.replace(/\u00a0·\u00a0(GPU|CPU|Computer)$/, "").replace(/ · (GPU|CPU|Computer)$/, "");

/** What runs a task right now, in a few words: "Llama Matcha (Kale's voice), in this browser · ready". */
export function nowText(active: ActiveSpeech, waiting: string, meanwhile = ""): string {
  if (active.where === "computer") return `${loadedName(active.name)}, on your computer · ready`;
  if (active.where === "card") return "a voice from your cards";
  const { status } = active;
  const name = status.name === null ? waiting : loadedName(status.name);
  const phase =
    status.phase === "ready"
      ? `ready${status.total > 0 ? `, ${MB(status.total)}` : ""}`
      : status.phase === "downloading"
        ? "downloading"
        : status.phase === "loading"
          ? "loading"
          : status.phase === "failed"
            ? "didn't load"
            : "loads with the\u00a0call";
  return `${name}, in this browser${meanwhile} · ${phase}`;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** How long something has been going, as m:ss. */
const elapsed = (since: number) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What Automatic picked for a task and why, from the runtime's own decision and timings. */
function automaticWhy(task: "stt" | "voice", computer: ReturnType<typeof computerSpeechState>): string {
  const { browser, computer: there } = speechTimings()[task];
  const runs = speechRunsAt(task);
  const since = runs.since === null ? "" : ` · since ${clock(runs.since)}`;
  // Each timing on its own, so a missing one says so instead of hiding the other.
  const measured =
    there === undefined && browser === undefined
      ? "not measured yet"
      : `per second of audio: computer ${there === undefined ? "not measured" : seconds(there)}, here ${
          browser === undefined ? "not measured" : seconds(browser)
        }`;
  if (!automaticTriesComputer(task)) return "Kale's voice, in this browser: a phone keeps it";
  if (computer === "absent") return "this browser; your computer once T3 Code is connected";
  if (browserFaster(task)) return `this browser, faster here · ${measured}${since}`;
  if (runs.where === "computer")
    return `your computer${browser === undefined ? " (nothing to download)" : ""} · ${measured}${since}`;
  return `this browser until your computer answers · ${measured}${since}`;
}

/**
 * Under a task's description, at most two short lines: what went wrong with your computer (only when
 * it couldn't start: its reason and Try again), then "Now:" what actually runs the task here and its
 * state, with a scan while your computer is still being tried and a bar while a model downloads.
 */
function TaskState(props: {
  readonly picked: string;
  readonly auto: string;
  readonly standIn: string;
  readonly computer: ReturnType<typeof computerSpeechState>;
  readonly active: ActiveSpeech;
  readonly task: "stt" | "voice";
  /** The picked (or automatic) browser model's cost, while nothing is loaded yet. */
  readonly cost?: string | undefined;
}) {
  const { picked, auto, standIn, computer, active } = props;
  const status = active.where === "browser" ? active.status : null;
  const failed = status?.phase === "failed";
  const trying = tryingComputer(props.task);
  const couldNotStart = trying && computer === "down";
  const waiting =
    picked === "computer" || (picked === "auto" && trying)
      ? standIn
      : picked === "auto"
        ? auto
        : (STT_LABELS[picked as Exclude<SttModel, "auto">] ?? VOICE_LABELS[picked as VoiceBuild] ?? auto);
  // A stand-in says why it is here, on its own row too.
  const meanwhile = !trying ? "" : couldNotStart ? " while your computer is out" : " while your computer starts";
  let now = `Now: ${nowText(active, waiting, meanwhile)}`;
  if (picked === "computer" && computer === "absent") now += " (connect T3 Code first)";
  if (status?.phase === "idle" && props.cost)
    now = now.replace(" · loads with the\u00a0call", ` · ${props.cost.split(" download")[0]}, loads with the\u00a0call`);
  if (failed)
    now += status.error?.includes(NEEDS_WEBGPU)
      ? `. ${status.error} Pick Automatic or a CPU model.`
      : `. ${status.error ?? ""}${status.retryAt > 0 ? " Trying again shortly." : " It tries again from the next call."}`;
  return (
    <>
      {/* The live region says the phase; the changing megabytes stay out of it. */}
      <span role="status" data-lalala-settings-state="">
        <b data-lalala-settings-now="">Now:</b>{" "}
        {failed ? (
          <span data-lalala-settings-problem="">{now.slice(5)}</span>
        ) : (
          now.slice(5)
        )}
        {status?.phase === "downloading" && status.total > 0 ? (
          <>
            <span aria-hidden="true">{` ${MB(status.loaded)} of\u00a0${MB(status.total)}`}</span>
            <span
              role="progressbar"
              aria-label={props.task === "stt" ? "Speech-to-text model download" : "Reply voice model download"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((100 * status.loaded) / status.total)}
              data-lalala-settings-meter=""
              style={{ "--done": Math.min(1, status.loaded / status.total) } as CSSProperties}
            />
          </>
        ) : null}
      </span>
      {picked === "auto" ? (
        <span data-lalala-settings-why="">
          <b data-lalala-settings-now="">Automatic:</b> {automaticWhy(props.task, computer)}
        </span>
      ) : null}
    </>
  );
}

/**
 * Which model hears you and which speaks, and where each runs: in this browser or on the computer
 * running T3 (Automatic tries it too). Saved on this device; the two don't have to match.
 */
export function SpeechSection() {
  const ears = useSttModel();
  const voice = useReplyVoicePick();
  const plugins = useSyncExternalStore(subscribeReplyVoices, replyVoicePlugins, replyVoicePlugins);
  useSyncExternalStore(subscribeSpeechState, speechStateVersion, speechStateVersion);
  const gpu = useGpu();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the computer's speech service whether it can take a task, each time Settings open
  useEffect(() => void refreshComputerSpeech(), []);
  const computer = computerSpeechState();
  const phone = isPhoneDevice();

  const autoEars: BrowserEars | null = phone
    ? "110m"
    : gpu === null
      ? null
      : gpu.f16
        ? "0.6b-gpu"
        : "0.6b-cpu";
  const autoVoice: VoiceBuild | null = phone
    ? "matcha"
    : gpu === null
      ? null
      : gpu.any
        ? "kokoro-gpu"
        : "kokoro-cpu";
  // Who stands in for your computer's voice: the same Kokoro here on a desktop, Matcha on a phone.
  const voiceStandIn: VoiceBuild | null = phone ? "matcha" : autoVoice;
  const earsAuto = autoEars === null ? CHECKING : STT_LABELS[autoEars];
  const voiceAuto = autoVoice === null ? CHECKING : VOICE_LABELS[autoVoice];
  // The computer's line in the list: its state, and how fast it is once it answers.
  const computerOption = (speed: string | undefined) =>
    computer === "absent"
      ? { meta: COMPUTER_COPY.absent.meta, disabled: true }
      : {
          meta:
            computer === "ready"
              ? `${COMPUTER_COPY.ready.meta}${speed === undefined ? "" : ` · ${speed}`}`
              : COMPUTER_COPY[computer].meta,
        };
  // On a phone the big builds have ended the tab (Tim's iPhone, 14 Nov): picking them stays allowed.
  const wanted = tryingComputer("stt") || tryingComputer("voice");
  const down = wanted && computer === "down";
  const trying = wanted && !down;
  // The elapsed time counts while your computer is being tried: text only, once a second.
  const [, tick] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a clock for the live "trying" line, only while it shows
  useEffect(() => {
    if (!trying) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [trying]);
  const heavy = (detail: string) => (phone ? `${detail}, may close a phone tab` : detail);

  return (
    <Section
      title="Speech models"
      named
      // The live region stays mounted, so the failure is announced when it appears; the button sits outside it.
      note={
        <>
          <span role="status" data-lalala-settings-announce="">
            {down ? (
              <>
                <span data-lalala-settings-problem="">Your computer's speech service couldn't start.</span>
                {computerSpeechReason() ? ` ${computerSpeechReason()}` : ""} Trying again on its own.
              </>
            ) : trying ? (
              <>
                {computer === "starting" && viaT3()
                  ? "Starting the speech service on your computer, through T3 Code…"
                  : COMPUTER_LIVE[computer]}
                {computerSpeechReason() ? ` ${computerSpeechReason()}.` : ""}
              </>
            ) : null}
          </span>
          {trying ? (
            <>
              <span aria-hidden="true" data-lalala-settings-elapsed="">
                {elapsed(computerSpeechSince())}
              </span>
              <span data-lalala-settings-trying="" aria-hidden="true" />
            </>
          ) : null}
          {down ? (
            <button
              type="button"
              data-lalala-settings-button=""
              data-quiet=""
              onClick={() => void refreshComputerSpeech(true)}
            >
              Retry now
            </button>
          ) : null}
        </>
      }
    >
      <PickRow
        title="Speech-to-text"
        description={
          <>
            Hears you, from the next thing you say.
            <TaskState
              cost={
                STT_COSTS[
                  ears === "computer" || (ears === "auto" && tryingComputer("stt"))
                    ? "110m"
                    : ears === "auto"
                      ? (autoEars ?? "")
                      : ears
                ]
              }
              picked={ears}
              auto={earsAuto}
              standIn={STT_LABELS["110m"]}
              computer={computer}
              task="stt"
              active={activeSpeech("stt")}
            />
          </>
        }
        label="Speech-to-text"
        value={ears}
        shows={
          ears === "auto"
            ? modelOnly(runningName("stt", tryingComputer("stt") ? STT_LABELS["110m"] : earsAuto))
            : undefined
        }
        onReset={ears === "auto" ? undefined : () => setSttModel("auto")}
        groups={[
          {
            options: [
              {
                value: "auto",
                label: "Automatic",
                ...automaticOption(
                  "stt",
                  computer,
                  { label: earsAuto, cost: autoEars === null ? undefined : STT_COSTS[autoEars] },
                  { label: STT_LABELS["110m"], cost: STT_COSTS["110m"] },
                ),
              },
            ],
          },
          {
            label: "In this browser",
            options: [
              {
                value: "0.6b-gpu",
                label: STT_LABELS["0.6b-gpu"],
                ...(gpu !== null && !gpu.f16
                  ? { meta: "Needs WebGPU with 16-bit floats", disabled: true }
                  : { detail: heavy("best accuracy"), meta: STT_COSTS["0.6b-gpu"] }),
              },
              {
                value: "0.6b-cpu",
                label: STT_LABELS["0.6b-cpu"],
                detail: heavy("same accuracy, slower"),
                meta: STT_COSTS["0.6b-cpu"],
              },
              {
                value: "110m",
                label: STT_LABELS["110m"],
                detail: "fastest, a few more wrong words",
                meta: STT_COSTS["110m"],
              },
            ],
          },
          {
            label: "On your computer",
            options: [
              {
                value: "computer",
                label: STT_LABELS.computer,
                detail: "best accuracy",
                ...computerOption(measuredComputer("stt")),
              },
            ],
          },
        ]}
        onChange={(value) => setSttModel(value as SttModel)}
      />
      <PickRow
        title="Reply voice"
        description={
          <>
            Speaks the answers, from the next sentence.
            <TaskState
              cost={
                VOICE_COSTS[
                  voice === "computer" || voice === "auto" ? (voiceStandIn ?? "") : voice
                ]
              }
              picked={voice}
              auto={voiceAuto}
              standIn={voiceStandIn === null ? CHECKING : VOICE_LABELS[voiceStandIn]}
              computer={computer}
              task="voice"
              active={activeSpeech("voice")}
            />
          </>
        }
        label="Reply voice"
        value={voice}
        shows={
          voice === "auto"
            ? modelOnly(runningName("voice", voiceStandIn === null ? voiceAuto : VOICE_LABELS[voiceStandIn]))
            : undefined
        }
        onReset={voice === "auto" ? undefined : () => setReplyVoice("auto")}
        groups={[
          {
            options: [
              {
                value: "auto",
                label: "Automatic",
                ...automaticOption(
                  "voice",
                  automaticTriesComputer("voice") ? computer : "absent",
                  { label: voiceAuto, cost: autoVoice === null ? undefined : VOICE_COSTS[autoVoice] },
                  {
                    label: voiceAuto,
                    cost: autoVoice === null ? "" : (VOICE_COSTS[autoVoice] ?? ""),
                  },
                ),
              },
            ],
          },
          {
            label: "In this browser",
            options: [
              {
                value: "kokoro-gpu",
                label: VOICE_LABELS["kokoro-gpu"],
                ...(gpu !== null && !gpu.any
                  ? { meta: "Needs WebGPU", disabled: true }
                  : { detail: heavy("most natural"), meta: VOICE_COSTS["kokoro-gpu"] }),
              },
              {
                value: "kokoro-cpu",
                label: VOICE_LABELS["kokoro-cpu"],
                detail: phone ? "natural, about 2× a sentence to render" : "natural, slower",
                meta: VOICE_COSTS["kokoro-cpu"],
              },
              {
                value: "matcha",
                label: VOICE_LABELS.matcha,
                detail: "fastest",
                meta: VOICE_COSTS.matcha,
              },
            ],
          },
          {
            label: "On your computer",
            options: [
              {
                value: "computer",
                label: VOICE_LABELS.computer,
                detail: "most natural",
                ...computerOption(measuredComputer("voice")),
              },
            ],
          },
          ...(plugins.length > 0
            ? [
                {
                  label: "From your cards",
                  options: plugins.map((plugin) => ({
                    value: plugin.id,
                    label: plugin.label,
                    meta: "In this browser · size set by its card",
                  })),
                },
              ]
            : []),
        ]}
        onChange={(value) => setReplyVoice(value)}
      />
    </Section>
  );
}

/**
 * What happens as lalala opens on this device: whether the call starts by itself, and whether a page
 * or speech model that fails to load tries again on its own.
 */
export function OpeningSection() {
  const seconds = useAutoRetrySeconds();
  const autoStart = useAutoStartCall();
  return (
    <Section title="Startup">
      <Row
        title="Start the call when lalala opens"
        description="Safari and phones wait for a first tap."
      >
        {(describedBy) => (
          <Toggle
            on={autoStart}
            label="Start the call when lalala opens"
            describedBy={describedBy}
            onChange={setAutoStartCall}
          />
        )}
      </Row>
      <PickRow
        title="Retry when loading fails"
        description={
          seconds === null
            ? "Off: when the page or a speech model doesn't load, reload or start a call to try again. lalala still waits for your computer's speech service and for free storage."
            : "When the page or a speech model doesn't load, lalala tries again on its own until it does."
        }
        label="Retry when loading fails"
        value={seconds === null ? "off" : String(seconds)}
        onReset={
          seconds === DEFAULT_AUTO_RETRY_SECONDS
            ? undefined
            : () => setAutoRetrySeconds(DEFAULT_AUTO_RETRY_SECONDS)
        }
        groups={[
          {
            options: [
              ...AUTO_RETRY_CHOICES.map((every) => ({
                value: String(every),
                label: `Every ${every} s`,
              })),
              { value: "off", label: "Off" },
            ],
          },
        ]}
        onChange={(value) => setAutoRetrySeconds(value === "off" ? null : Number(value))}
      />
    </Section>
  );
}

const LLAMA_LICENSE =
  "https://github.com/KaleComputer/lalala/blob/main/src/voice/browserSpeech/matcha/LLAMA-3.2-LICENSE.txt";

/** Who made the speech models; the Llama lines are its licence's terms for Kale's voice (NOTICE.md). */
export function CreditsSection() {
  return (
    <Section
      title="Credits"
      fine
      note={
        <>
          Speech runs on NVIDIA Parakeet (CC-BY-4.0), Kokoro (Apache-2.0), Silero VAD (MIT) and Kale's
          voice, Llama Matcha. <strong>Built with Llama</strong>: Llama Matcha learned to speak from
          audio made with Maya1, which is built on Llama 3.2. Llama 3.2 is licensed under the{" "}
          <a href={LLAMA_LICENSE} target="_blank" rel="noreferrer">
            Llama 3.2 Community License
          </a>
          , Copyright © Meta Platforms, Inc. All Rights Reserved.
        </>
      }
    />
  );
}

function VolumeRow() {
  const percent = Math.round(useSoundVolume() * 100);
  const id = useId();
  return (
    <Row
      title="Sounds volume"
      description="Every sound but the voice: the update sound, call chimes, card samples and games."
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
        description="Scrambles thread titles and every card's text, for screen sharing. Pictures stay, except in cards and groups marked “Hide in streamer mode” (right-click or long-press a card's header or a group's name)."
      >
        {(describedBy) => (
          <Toggle
            on={streamer}
            label="Streamer mode"
            describedBy={describedBy}
            onChange={setStreamerMode}
          />
        )}
      </Row>
      <RemovedRows />
    </Section>
  );
}

const NO_MARKS = {};
const noMarks = () => () => undefined;

/** Cards and groups taken off the canvas from their menu, each with a way back. */
function RemovedRows() {
  const api = globalThis.__lalalaCanvases;
  // Re-renders on every mark change; the list itself is read from the canvas below.
  const marks = api?.marks ?? (() => NO_MARKS);
  useSyncExternalStore(api?.subscribeMarks ?? noMarks, marks, () => NO_MARKS);
  const removed = api?.removed?.() ?? [];
  return removed.map((item) => (
    <Row
      key={item.key}
      title={item.kind === "group" ? "Removed group" : "Removed card"}
      description={
        <>
          <StreamerText text={item.name} />
          {item.kind === "group" ? " and its cards" : null}
        </>
      }
    >
      <button type="button" data-lalala-settings-button="" onClick={() => api?.restore(item.key)}>
        Put back
      </button>
    </Row>
  ));
}
