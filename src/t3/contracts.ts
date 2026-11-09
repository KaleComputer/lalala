// Standalone stand-in for @t3tools/contracts: only what the copied voice code uses.
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export type ThreadId = string;
export type ConfirmDialogVariant = "default" | "destructive";
export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
}
export type OrchestrationV2ProjectedTurnItem = {
  readonly visibility: "local" | "inherited" | "synthetic";
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly parentItemId: string | null;
    readonly messageId?: string | null;
    readonly startedAt: string | null;
    readonly updatedAt: string;
  };
};
