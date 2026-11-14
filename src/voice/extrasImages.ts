declare global {
  var __lalalaImages: Readonly<Record<string, string>> | undefined;
}

// The cards' pictures and sounds as URLs. Self-accepting: a replaced picture updates its card, not the page.
globalThis.__lalalaImages = import.meta.glob<string>(
  // Every .mp3 except the inlined game effects; a sample missing here is a dead link in the phone build.
  [
    "./extras/*.jpg",
    "./extras/*.webp",
    "./extras/*.mp3",
    "./extras/*.mp4",
    "!./extras/pulseWardenSfx-*.mp3",
  ],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

import.meta.hot?.accept();
