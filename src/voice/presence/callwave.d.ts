// Types for callwave.js, Presence's call wave (copied by scripts/lalala-presence-sync.mjs).
export interface CallWaveLevels {
  input?: number;
  output?: number;
}
export interface CallWaveSpectrum {
  input?: Uint8Array | null;
  output?: Uint8Array | null;
  inputWave?: Float32Array | null;
  outputWave?: Float32Array | null;
  rate?: number;
}
export interface CallWave {
  frame(levels?: CallWaveLevels, spectrum?: CallWaveSpectrum | null): void;
  readonly resting: boolean;
  readonly fading: boolean;
  setFill(fill: number | null): void;
  /** An info state's plate: the ASCII display's motion behind it and the plate's span (CSS px); null, none. */
  setInfo(
    info: { mode: "wave" | "scan" | "pulse"; hole: readonly [number, number] | null } | null,
  ): void;
}
export function createCallWave(
  canvas: HTMLCanvasElement,
  options?: {
    reduced?: boolean;
    wash?: Element | null;
    state?: () => { look: string; audio?: string; reading?: boolean; open?: boolean };
    bars?: () => Element | null;
  },
): CallWave;
