// Types for frame.js, Presence's call frame.
export interface PresenceFrame {
  state(input: { line: string; voice: string }): void;
  thread(on: boolean): void;
  stopped(): void;
  cue(name: string): void;
  learning(progress: number | null): void;
  open(on: boolean): void;
  readonly look: string;
  readonly audio: string;
}
export function createFrame(input: {
  bar: HTMLElement;
  frame: HTMLElement;
  reduced?: boolean;
}): PresenceFrame;
