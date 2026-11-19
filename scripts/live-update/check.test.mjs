// Card and data edits during a call apply in place and never light the bar's update chip; only
// lalala's own code waits for the call to end. On 19 Nov needsTim.json and card commits lit the chip
// over and over: the chip kept its own copy of this rule, without the cards folder.
// Run: node --experimental-strip-types --test scripts/live-update/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { appliesLive } from "../../src/voice/liveUpdate.ts";

const CARDS = "/@fs/srv/brain/cards/";

test("the user's cards and their data apply live", () => {
  for (const path of [
    `${CARDS}NeedsTim.tsx`,
    `${CARDS}needsTimItems.ts?t=1763550000000`,
    `${CARDS}needsTim.json?import&t=1`,
    `${CARDS}index.tsx`,
  ]) {
    assert.equal(appliesLive(path, CARDS), true, path);
  }
});

test("extras and CSS apply live", () => {
  assert.equal(appliesLive("/src/voice/extras/CanvasCard.tsx", CARDS), true);
  assert.equal(appliesLive("/src/voice/voiceBar.css?t=2", CARDS), true);
});

test("lalala's own code is an app update", () => {
  for (const path of ["/src/voice/VoiceBar.tsx", "/src/voice/speechText.ts?t=3", "/src/app/main.tsx"]) {
    assert.equal(appliesLive(path, CARDS), false, path);
  }
  assert.equal(appliesLive(`${CARDS}NeedsTim.tsx`, undefined), false);
});
