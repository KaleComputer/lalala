// lalala.talk's side of src/voice/adapters: no server, so layout and settings stay in this browser.
// Imported before the canvas, whose store reads the adapters when it loads.
import { installAdapters } from "../../../src/voice/adapters";
import { browserStorage } from "../../../src/voice/adapters/storage/browser";

installAdapters({ storage: browserStorage });

// The settings' topic sounds, where the app's build lists them (src/voice/extrasImages.ts).
globalThis.__lalalaImages = Object.fromEntries(
  (process.env.LALALA_TOPIC_SOUNDS ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => [`./extras/topicSounds-${name}.mp3`, `/sounds/${name}.mp3`]),
);
