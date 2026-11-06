// Standalone: the voice thread already exists, so no default model is needed to create one.
export const primaryServerSettingsAtom = {
  defaultModelSelection: null as { readonly instanceId: string; readonly model: string } | null,
};
