// The call's audio route, from the microphone it opened: a Bluetooth headset's call mode (HFP)
// delivers the mic at 16 kHz or less and plays everything back through the same narrow call codec,
// which made every voice sound thin and metallic on Tim's headset (16 Nov).
let micRate: number | null = null;

export const NARROWBAND_HZ = 16_000;
/** Max wait when resuming a replacement AudioContext after an audio route/rate change. */
export const CONTEXT_RESUME_TIMEOUT_MS = 400;

/** The live call's mic sample rate, or null out of a call. */
export const callMicRate = () => micRate;
/** The call runs on a narrow (Bluetooth call) route: playback is shaped for it. */
export const narrowbandCall = () => micRate !== null && micRate <= NARROWBAND_HZ;
export function setCallMicRate(rate: number | null) {
  if (rate === micRate) return;
  micRate = rate;
  if (typeof document !== "undefined") document.dispatchEvent(new Event("lalala:mic-label"));
}

export type TrackRouteInfo = {
  readonly label: string | null;
  readonly settings: MediaTrackSettings | null;
  readonly trackRate: number | null;
  readonly routeRate: number;
};

/**
 * Summarizes the live mic track and effective call route rate. A narrowband Bluetooth call route
 * (<= 16 kHz) shows on the mic track on iOS and on the hardware AudioContext on macOS Chrome, so
 * take the narrower of the two.
 */
export function trackRouteInfo(stream: MediaStream, context: Pick<AudioContext, "sampleRate">): TrackRouteInfo {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? null;
  const trackRate = typeof settings?.sampleRate === "number" ? settings.sampleRate : null;
  const routeRate = trackRate === null ? context.sampleRate : Math.min(trackRate, context.sampleRate);
  return {
    label: track?.label || null,
    settings,
    trackRate,
    routeRate,
  };
}

/** Whether reopening the microphone warrants probing or rebuilding the AudioContext. */
export function routeRebuildCheck(params: {
  readonly rebuildContext: boolean;
  readonly prevLabel: string | null;
  readonly prevRate: number | null;
  readonly nextLabel: string | null;
  readonly nextRate: number | null;
  readonly contextRate: number;
}): { readonly shouldCheck: boolean; readonly forceRebuild: boolean } {
  const labelChanged =
    params.nextLabel !== null && params.prevLabel !== null && params.nextLabel !== params.prevLabel;
  const rateChanged =
    (params.nextRate !== null && params.prevRate !== null && params.nextRate !== params.prevRate) ||
    (params.nextRate !== null && params.nextRate !== params.contextRate);
  const forceRebuild = params.rebuildContext || labelChanged;
  return { shouldCheck: forceRebuild || rateChanged, forceRebuild };
}

export async function resumeContextBriefly(
  context: Pick<AudioContext, "state" | "resume">,
  timeoutMs = CONTEXT_RESUME_TIMEOUT_MS,
): Promise<void> {
  if ((context.state as string) === "running") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    context.resume().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * Probes the current OS hardware output rate after `getUserMedia` has opened or switched the audio
 * route. On iOS, creating the AudioContext before `getUserMedia` locks it at 44.1 kHz (A2DP) while
 * Bluetooth HFP runs at 16 kHz (or vice versa on `iPhone Microphone` at 48 kHz). When the hardware
 * rate actually changed — or `forceRebuild` is set after a route drop (`mic.ended`) — returns a
 * fresh running AudioContext; otherwise closes the probe and returns `current`.
 */
export async function matchHardwareContext<T extends Pick<AudioContext, "sampleRate" | "state" | "resume" | "close">>(
  current: T,
  trackRate: number | null,
  forceRebuild: boolean,
  createContext: () => T = () => new AudioContext() as unknown as T,
  timeoutMs = CONTEXT_RESUME_TIMEOUT_MS,
): Promise<T> {
  if (!forceRebuild && (trackRate === null || trackRate === current.sampleRate)) return current;
  let fresh: T;
  try {
    fresh = createContext();
  } catch {
    return current;
  }
  if (!forceRebuild && fresh.sampleRate === current.sampleRate) {
    void fresh.close().catch(() => {});
    return current;
  }
  await resumeContextBriefly(fresh, timeoutMs);
  if ((fresh.state as string) === "running" || (current.state as string) !== "running") {
    return fresh;
  }
  void fresh.close().catch(() => {});
  return current;
}
