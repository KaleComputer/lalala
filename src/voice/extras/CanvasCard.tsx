import {
  Component,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type Rect,
  boxKey,
  declareCard,
  getCamera,
  getCanvases,
  getCards,
  homeOf,
  isDrawn,
  mountCard,
  scrollTops,
  subscribe,
  subscribeCanvases,
} from "./canvasStore";

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
  { readonly card: string; readonly children: ReactNode },
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
        <b>This card stopped working.</b>
        <code>{this.state.error}</code>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

/**
 * A card on the canvas: `at` is where it starts (world px; it narrows to fit a phone), and after
 * that it stays wherever the user drags its header or corner (canvasStore remembers it). It shows only
 * on its `canvas` (an id or a name), or on Main without one.
 */
export function CanvasCard(props: {
  readonly id: string;
  readonly title: string;
  readonly at: Rect;
  readonly canvas?: string;
  /** Gives the card a close button (lalala.talk, where visitors arrange the canvas themselves). */
  readonly onRemove?: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const { id, title, canvas } = props;
  // Idempotent: lets focus find a card on any canvas, shown or not.
  declareCard(id, canvas, title);
  // Only the first place counts; after that the card is wherever it was put.
  const [at] = useState(props.at);
  const { active, list } = useSyncExternalStore(subscribeCanvases, getCanvases);
  const shown = active !== "" && homeOf(canvas, list) === active;
  const key = boxKey(active, id);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves and sizes the card from canvasStore, outside React, while it is dragged
  useLayoutEffect(() => {
    if (!shown) return;
    const unmount = mountCard(key, firstPlace(at));
    // A swap remounts every card: its list opens where it was scrolled to, before paint.
    const body = ref.current?.querySelector<HTMLElement>("[data-lalala-card-body]");
    if (body && scrollTops[key]) body.scrollTop = scrollTops[key];
    let last: Rect | undefined;
    let lastCamera: unknown;
    // The element outlives a change of canvas: carry on from what it shows.
    let off = ref.current?.hasAttribute("data-lalala-card-off") ?? false;
    let titleSize = -1;
    const apply = () => {
      const card = ref.current;
      if (card === null) return;
      const rect = getCards()[key];
      const camera = getCamera();
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
      unsubscribe();
      unmount();
    };
  }, [key, shown, at]);

  if (!shown) return null;
  return (
    <section ref={ref} data-lalala-card={key} style={style(getCards()[key])}>
      <header data-lalala-card-grip="">{title}</header>
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
        <CardBoundary card={id}>{props.children}</CardBoundary>
      </div>
      <span data-lalala-card-resize="" aria-hidden />
    </section>
  );
}
