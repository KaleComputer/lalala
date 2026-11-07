// Standalone: the brain's context size and compaction state, from the T3 bridge.
import { useBridge } from "../t3/bridge";
import type { VoiceBrainContext } from "../voice/brainCompaction";

export function useVoiceBrainContext(ref: unknown): VoiceBrainContext | null {
  const context = useBridge((state) => state.context);
  return ref === null ? null : context;
}
