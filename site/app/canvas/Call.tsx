import { type ComponentProps } from "react";

import { VoiceBar } from "../../../src/voice/VoiceBar";
import { VoiceHost } from "../../../src/voice/VoiceHost";
import { onVoiceSettingsClosed, openVoiceSettings } from "../../../src/voice/VoiceSettings";
import { callStartsWith, useBrainVersion, wantCallOnConnect } from "./adapters";

type BarProps = Partial<ComponentProps<typeof VoiceBar>>;

const openConnection = () => {
  wantCallOnConnect(true);
  openVoiceSettings("Connection");
};

// Closing the settings without connecting drops the tap's intent; the gear never starts a call.
onVoiceSettingsClosed(() => wantCallOnConnect(false));

/**
 * The canvas's call: the app's own VoiceHost once this browser is paired with a T3 Code. Until then
 * the same bar, out of a call, whose call button opens the settings at Connection.
 */
export function Call(props: BarProps) {
  const brain = useBrainVersion();
  if (brain !== 0) return <VoiceHost key={brain} bar={props} autoStart={callStartsWith(brain)} />;
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
