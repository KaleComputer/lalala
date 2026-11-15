import {
  Component,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import "./cutFrame.css";
import { Hidden } from "./streamer";
import {
  type Rect,
  boxKey,
  declareCard,
  fitCard,
  getCamera,
  getCanvases,
  getCards,
  getMarks,
  getSelected,
  homeOf,
  isDrawn,
  isLayered,
  isNear,
  isPrivate,
  isRemoved,
  mountCard,
  scrollTops,
  setLoaded,
  subscribe,
  subscribeCanvases,
  subscribeMarks,
} from "./canvasStore";
import { holdScroll } from "./cardState";
import { cardThreads } from "./cardThreads";

declare global {
  /** The session log, set by the page that has one (VoiceExtrasSlot); this folder may not import it. */
  var __lalalaLog:
    | ((who: "system", type: string, data?: Record<string, unknown>) => void)
    | undefined;
}

/** The bar and its rail need this much room at the bottom of the first view. */
const BAR_ROOM = 188;

const firstPlace = ({ x, y, w, h }: Rect): Rect => ({
  x,
  y,
  w: Math.min(w, window.innerWidth - 24),
  h: Math.min(h, Math.max(160, window.innerHeight - y - BAR_ROOM)),
});

const snap = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio;

/**
 * Where the camera puts a card's box on the screen. Each card moves by itself (no moving layer
 * around them all: that one holds the whole canvas at full sharpness) and scales about its middle.
 * A new card stays hidden until canvasStore has found it a free spot.
 */
const style = (rect: Rect | undefined) => {
  if (rect === undefined) return { visibility: "hidden" as const };
  const { x, y, z } = getCamera();
  return {
    width: `${rect.w}px`,
    height: `${rect.h}px`,
    translate: `${snap(x + rect.x * z - (rect.w * (1 - z)) / 2)}px ${snap(y + rect.y * z - (rect.h * (1 - z)) / 2)}px`,
    scale: `${z}`,
    visibility: "visible" as const,
  };
};

/** A card that throws shows that in its own box; the rest of the canvas and the call carry on. */
class CardBoundary extends Component<
  { readonly card: string; readonly box: string; readonly children: ReactNode },
  { readonly error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  override componentDidCatch(error: unknown) {
    globalThis.__lalalaLog?.("system", "error", {
      where: "card",
      card: this.props.card,
      message: String(error),
    });
  }
  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div data-lalala-card-error="">
        {/* As far as loading goes, it's in. */}
        <Loaded card={this.props.box} />
        <b>This card stopped working.</b>
        <code>{this.state.error}</code>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

/** Rendered once everything before it in the card's Suspense has: the card's content is in. */
function Loaded(props: { readonly card: string }) {
  const { card } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells canvasStore (outside React) the card's content arrived, for the bar's loading readout
  useLayoutEffect(() => {
    setLoaded(card, true);
    return () => setLoaded(card, false);
  }, [card]);
  return null;
}

/** A card whose content is still on its way: its frame and title, and this. */
const loading = <div data-lalala-card-loading="">Loading</div>;

declare global {
  var __lalalaOpenThread: ((threadId: string) => void) | undefined;
}

/**
 * A card on the canvas: `at` is where it starts (world px), then it stays where the user drags it. It
 * shows only on its `canvas` (id or name), else on Main. A grouped card lands with its `group`;
 * `exact` pins an ungrouped one right at `at` unless that overlaps a card.
 */
export function CanvasCard(props: {
  readonly id: string;
  readonly title: string;
  readonly at: Rect;
  readonly canvas?: string;
  readonly exact?: boolean;
  readonly group?: string;
  /**
   * Shows real people or other private things: streamer mode blanks its pictures and video too, not
   * only its text. The card's menu (and its group's) can change it on every device.
   */
  readonly private?: boolean;
  /** Gives the card a close button (lalala.talk, where visitors arrange the canvas themselves). */
  readonly onRemove?: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const { id, title, canvas, exact = false, group } = props;
  const byDefault = props.private ?? false;
  const thread = cardThreads[id];
  // Idempotent: lets focus find a card on any canvas, shown or not.
  declareCard(id, canvas, title, group, byDefault);
  // Only the first place counts; after that the card is wherever it was put.
  const [at] = useState(props.at);
  // Its content renders (and its code loads) once the card first comes near the screen.
  const [near, setNear] = useState(false);
  const { active, list } = useSyncExternalStore(subscribeCanvases, getCanvases);
  const marks = useSyncExternalStore(subscribeMarks, getMarks);
  const shown = active !== "" && homeOf(canvas, list) === active && !isRemoved(id, group, marks);
  const key = boxKey(active, id);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves and sizes the card from canvasStore, outside React, while it is dragged
  useLayoutEffect(() => {
    if (!shown) return;
    const unmount = mountCard(key, firstPlace(at));
    // A swap remounts every card: its list opens where it was scrolled to, before paint.
    const body = ref.current?.querySelector<HTMLElement>("[data-lalala-card-body]");
    if (body && scrollTops[key]) body.scrollTop = scrollTops[key];
    // After a reload the content may still be short of where it was scrolled to.
    const release = body ? holdScroll(body, scrollTops[key] ?? 0) : undefined;
    let last: Rect | undefined;
    let lastCamera: unknown;
    // The element outlives a change of canvas: carry on from what it shows.
    let off = ref.current?.hasAttribute("data-lalala-card-off") ?? false;
    let flat = ref.current?.hasAttribute("data-lalala-card-flat") ?? false;
    let picked = ref.current?.hasAttribute("data-lalala-card-selected") ?? false;
    let titleSize = -1;
    const apply = () => {
      const card = ref.current;
      if (card === null) return;
      const rect = getCards()[key];
      const camera = getCamera();
      if (isNear(key)) setNear(true);
      if (rect !== last || camera !== lastCamera) {
        last = rect;
        lastCamera = camera;
        Object.assign(card.style, style(rect));
      }
      if (off === isDrawn(key)) {
        off = !off;
        card.toggleAttribute("data-lalala-card-off", off);
        // A list not drawn has no height to scroll: back where it was.
        if (!off && body && scrollTops[key]) body.scrollTop = scrollTops[key];
      }
      if (picked !== (getSelected() === key)) {
        picked = !picked;
        card.toggleAttribute("data-lalala-card-selected", picked);
      }
      if (flat === isLayered(key)) {
        flat = !flat;
        card.toggleAttribute("data-lalala-card-flat", flat);
      }
      // A frame's title stays readable however far out: it is all the card shows.
      const size = off && rect ? Math.round(Math.min(12 / camera.z, rect.w / 10, rect.h / 5)) : 0;
      if (size !== titleSize) {
        titleSize = size;
        card.style.setProperty("--lalala-card-title", size > 0 ? `${size}px` : null);
      }
    };
    apply();
    const unsubscribe = subscribe(apply);
    return () => {
      release?.();
      unsubscribe();
      unmount();
    };
  }, [key, shown, at]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- grows the card's box in canvasStore (outside React) when what it shows outgrows it
  useEffect(() => {
    const card = ref.current;
    const body = card?.querySelector<HTMLElement>("[data-lalala-card-body]");
    if (!shown || !near || !card || !body) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (card.hasAttribute("data-lalala-card-off")) return;
      fitCard(key, {
        w: body.scrollWidth - body.clientWidth,
        h: body.scrollHeight - body.clientHeight,
      });
    };
    const soon = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    // The content's own box changes when it loads data, opens a section or reflows; observers stay idle otherwise.
    const sizes = new ResizeObserver(soon);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(body);
      for (const child of body.children) sizes.observe(child);
    };
    const children = new MutationObserver(watch);
    children.observe(body, { childList: true });
    watch();
    // Switched back to growing with its content (the card's menu): fit now.
    let sized = getCards()[key]?.sized === true;
    const unsubscribe = subscribe(() => {
      const now = getCards()[key]?.sized === true;
      if (sized && !now) soon();
      sized = now;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      sizes.disconnect();
      children.disconnect();
      unsubscribe();
    };
  }, [key, shown, near]);

  if (!shown) return null;
  return (
    <section
      ref={ref}
      data-lalala-card={key}
      data-lalala-card-private={isPrivate(id, group, byDefault, marks) ? "" : undefined}
      style={style(getCards()[key])}
    >
      <header data-lalala-card-grip="">
        <span data-lalala-card-title="">
          <Hidden text={title} name />
        </span>
        {thread ? (
          <button
            type="button"
            data-lalala-card-thread=""
            data-cut=""
            aria-label={`Open the thread for ${title} in T3 Code`}
            onClick={() => globalThis.__lalalaOpenThread?.(thread)}
          >
            T3Code
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M3 1.5h5.5V7M8.5 1.5 1.5 8.5" />
            </svg>
          </button>
        ) : null}
      </header>
      {/* Beside the header, not in it: a press there would start a move. */}
      {props.onRemove ? (
        <button
          type="button"
          data-lalala-card-close=""
          aria-label={`Remove ${title}`}
          onClick={props.onRemove}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
      <div
        data-lalala-card-body=""
        onScroll={(event) => {
          if (!ref.current?.hasAttribute("data-lalala-card-off"))
            scrollTops[key] = event.currentTarget.scrollTop;
        }}
      >
        <CardBoundary card={id} box={key}>
          {near ? (
            <Suspense fallback={loading}>
              {props.children}
              <Loaded card={key} />
            </Suspense>
          ) : (
            loading
          )}
        </CardBoundary>
      </div>
      <span data-lalala-card-resize="" aria-hidden />
    </section>
  );
}
