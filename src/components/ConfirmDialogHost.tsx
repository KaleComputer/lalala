import { useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";

import { buttonVariants } from "./ui/button";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const message = state.status === "idle" ? "" : state.message;
  const copy = resolveConfirmDialogCopy(message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open, details) => {
        if (!open) respondToConfirmDialog(details.returnValue === "confirm");
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogBackdrop className="dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <AlertDialogContent className="dialog-glass fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 max-w-lg flex-col rounded-2xl border p-0 text-popover-foreground outline-none transition-[scale,opacity,translate] duration-200 ease-in-out data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4">
        <div className="flex min-h-0 flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left">
          <AlertDialogTitle className="wrap-anywhere m-0 shrink-0 font-semibold text-xl leading-snug">
            {copy.title}
          </AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="wrap-anywhere m-0 max-h-[min(24rem,60dvh)] min-h-0 overflow-y-auto overscroll-contain whitespace-pre-line text-muted-foreground text-sm select-text">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t bg-muted/72 px-6 py-4 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]">
          <AlertDialogClose className={buttonVariants({ variant: "outline" })}>Cancel</AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            className={buttonVariants({ variant: confirmVariant })}
            data-agent-confirm={message || undefined}
          >
            Confirm
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
