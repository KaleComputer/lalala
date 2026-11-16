// The call's audio route, from the microphone it opened: a Bluetooth headset's call mode (HFP)
// delivers the mic at 16 kHz or less and plays everything back through the same narrow call codec,
// which made every voice sound thin and metallic on Tim's headset (16 Nov).
let micRate: number | null = null;

export const NARROWBAND_HZ = 16_000;
/** The live call's mic sample rate, or null out of a call. */
export const callMicRate = () => micRate;
/** The call runs on a narrow (Bluetooth call) route: playback is shaped for it. */
export const narrowbandCall = () => micRate !== null && micRate <= NARROWBAND_HZ;
export function setCallMicRate(rate: number | null) {
  if (rate === micRate) return;
  micRate = rate;
  document.dispatchEvent(new Event("lalala:mic-label"));
}
