// Types for speech-constants.js, Presence's voiced-sound check.
export const VOICE_TOP: number;
export function harmonicity(data: Uint8Array): number;
export interface SpeechGate {
  update(data: Uint8Array | null, dtSeconds: number): number;
  readonly open: boolean;
  readonly value: number;
}
export function createSpeechGate(options?: {
  open?: number;
  hold?: number;
  sustain?: number;
  linger?: number;
  loud?: number;
}): SpeechGate;
