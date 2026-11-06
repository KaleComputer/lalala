// Standalone: only the confirm dialog the canvas menu uses, the same styled one as T3's web client.
import type { ConfirmDialogOptions } from "@t3tools/contracts";
import { requestConfirmDialog } from "./confirmDialog";

export function ensureLocalApi() {
  return {
    dialogs: {
      confirm: async (message: string, options?: ConfirmDialogOptions) =>
        requestConfirmDialog(message, options) ?? false,
    },
  };
}
