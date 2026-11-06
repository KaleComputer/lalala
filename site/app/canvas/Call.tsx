import { type ComponentProps, useState } from "react";

import { VoiceBar } from "../../../src/voice/VoiceBar";
import { VoiceHost } from "../../../src/voice/VoiceHost";
import { openVoiceSettings } from "../../../src/voice/VoiceSettings";
import { useBrainVersion } from "./adapters";

type BarProps = Partial<ComponentProps<typeof VoiceBar>>;

const openConnection = () => openVoiceSettings("Connection");

/**
 * The canvas's call: the app's own VoiceHost once this browser is paired with a T3 Code. Until then
 * the same bar, out of a call, whose call button opens the settings at Connection.
 */
export function Call(props: BarProps) {
  const brain = useBrainVersion();
  // The brain this page loaded with; a later one was just picked in Connection, so its call starts.
  const [loadedWith] = useState(brain);
  if (brain !== 0) return <VoiceHost key={brain} bar={props} autoStart={brain !== loadedWith} />;
  return (
    <VoiceBar
      {...props}
      state="off"
      message={null}
      disabled={false}
      label="Start voice"
      onPress={openConnection}
      analysis={() => null}
      onSubmit={() => {
        openConnection();
        return Promise.resolve(false);
      }}
      live={false}
      muted={false}
      onMute={() => {}}
    />
  );
}
