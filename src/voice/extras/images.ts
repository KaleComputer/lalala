/**
 * A card's picture, from `import url from "./name.jpg?url"`. Dev's URL is the bare file path, so it
 * gets a stamp per load of the card's module: a replaced file hot-updates only the card importing it.
 * The extras build serves the page build's hashed file instead (extras.config.ts, extrasImages.ts).
 */
export const fresh = (url: string) => (import.meta.env.DEV ? `${url}?t=${Date.now()}` : url);

/**
 * A card picture's smaller copy beside it: `name.thumb.jpg` (160 px wide) for strips, `name.mid.jpg`
 * (960 px) for what a card shows inside. The full file loads only when it is opened.
 */
export const smaller = (file: string, size: "thumb" | "mid") =>
  file.replace(/\.\w+$/, `.${size}.jpg`);
