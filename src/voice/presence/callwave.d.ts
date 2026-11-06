// Types for callwave.js, Presence's call wave.
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
