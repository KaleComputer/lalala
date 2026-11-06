import { type ComponentProps, useState } from "react";

import { browserBrain } from "../../../src/voice/adapters/harness/browser";
import { VoiceBar } from "../../../src/voice/VoiceBar";
import { VoiceHost } from "../../../src/voice/VoiceHost";

type BarProps = Partial<ComponentProps<typeof VoiceBar>>;

/**
 * The canvas's call: the app's own VoiceHost once this browser is paired with a T3 Code (/connect),
 * else the bar's call button opens the pairing.
 */
export function Call(props: BarProps) {
  const [paired] = useState(() => browserBrain() !== null);
  if (paired) return <VoiceHost bar={props} />;
  return (
    <VoiceBar
      {...props}
      state="off"
      message={null}
      disabled={false}
      label="Connect your T3 Code to talk"
      onPress={() => (location.href = "/connect")}
      analysis={() => null}
      live={false}
    />
  );
}
