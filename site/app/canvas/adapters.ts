// lalala.talk's side of src/voice/adapters: no server, so layout and settings stay in this browser,
// speech runs in it, and the call reaches the visitor's own T3 Code from the tab (once paired).
// Imported before the canvas, whose store and bridge read the adapters when they load.
import { installAdapters } from "../../../src/voice/adapters";
import { browserBrain, browserHarness } from "../../../src/voice/adapters/harness/browser";
import { browserSpeech } from "../../../src/voice/adapters/speech/browser";
import { browserStorage } from "../../../src/voice/adapters/storage/browser";

installAdapters({
  storage: browserStorage,
  speech: browserSpeech(),
  ...(browserBrain() ? { harness: browserHarness() } : {}),
});

// The settings' topic sounds, where the app's build lists them (src/voice/extrasImages.ts).
globalThis.__lalalaImages = Object.fromEntries(
  (process.env.LALALA_TOPIC_SOUNDS ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => [`./extras/topicSounds-${name}.mp3`, `/sounds/${name}.mp3`]),
);
