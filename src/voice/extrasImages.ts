declare global {
  var __lalalaImages: Readonly<Record<string, string>> | undefined;
}

// The cards' pictures and sounds as URLs. Self-accepting: a replaced picture updates its card, not the page.
globalThis.__lalalaImages = import.meta.glob<string>(
  ["./extras/*.jpg", "./extras/*.png", "./extras/*.mp3"],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

import.meta.hot?.accept();
