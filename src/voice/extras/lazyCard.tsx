import { type ComponentType, lazy } from "react";

type Props = Record<string, unknown>;

/**
 * A card's content as its own module, fetched the first time the card comes near the screen
 * (CanvasCard), so a big canvas doesn't hold the bar's requests behind every card's code.
 * vite/cards.mjs turns the cards entry's component imports into these.
 */
export function lazyCard(load: () => Promise<Record<string, unknown>>, name: string) {
  const make = () =>
    lazy(() =>
      load().then(
        (module) => ({ default: module[name] as ComponentType<Props> }),
        (cause: unknown) => {
          // A dropped fetch: the card's Try again (CanvasCard) fetches anew.
          Lazy = make();
          throw cause;
        },
      ),
    );
  let Lazy = make();
  function LazyCard(props: Props) {
    return <Lazy {...props} />;
  }
  LazyCard.displayName = name;
  return LazyCard;
}
