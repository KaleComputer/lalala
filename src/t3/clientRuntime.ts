// Standalone stand-ins for the @t3tools/client-runtime helpers VoiceHost uses.
export const scopeThreadRef = (environmentId: string, threadId: string) => ({ environmentId, threadId });
export const threadRuntimeIsActive = (runtime: { readonly status: string } | null | undefined) =>
  runtime != null && ["preparing", "queued", "starting", "running", "waiting"].includes(runtime.status);
export const squashAtomCommandFailure = (result: { readonly error?: unknown }) => result.error;
