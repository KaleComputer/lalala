import { type ReactNode, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type Rect,
  boxKey,
  declareCard,
  getCanvases,
  getCards,
  homeOf,
  mountCard,
  scrollTops,
  subscribe,
  subscribeCanvases,
} from "./canvasStore";

/** The bar and its rail need this much room at the bottom of the first view. */
const BAR_ROOM = 188;

const firstPlace = ({ x, y, w, h }: Rect): Rect => ({
  x,
  y,
  w: Math.min(w, window.innerWidth - 24),
  h: Math.min(h, Math.max(160, window.innerHeight - y - BAR_ROOM)),
});

// A new card stays hidden until canvasStore has found it a free spot.
const style = (rect: Rect | undefined) =>
  rect === undefined
    ? { visibility: "hidden" as const }
    : {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
        visibility: "visible" as const,
      };

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
    const body = ref.current?.querySelector<HTMLElement>("[data-t3voice-card-body]");
    if (body && scrollTops[key]) body.scrollTop = scrollTops[key];
    let last: Rect | undefined;
    const apply = () => {
      const rect = getCards()[key];
      if (rect === last || ref.current === null) return;
      last = rect;
      Object.assign(ref.current.style, style(rect));
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
    <section ref={ref} data-t3voice-card={key} style={style(getCards()[key])}>
      <header data-t3voice-card-grip="">{title}</header>
      <div
        data-t3voice-card-body=""
        onScroll={(event) => (scrollTops[key] = event.currentTarget.scrollTop)}
      >
        {props.children}
      </div>
      <span data-t3voice-card-resize="" aria-hidden />
    </section>
  );
}
