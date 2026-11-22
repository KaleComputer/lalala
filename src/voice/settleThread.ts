export type SettleDeps = {
  readonly harnessSettle?: () => Promise<void>;
  readonly fetchFn?: typeof fetch;
  readonly log?: (who: "user" | "brain", type: string, data: Record<string, unknown>) => void;
};

/**
 * Settles the current T3 brain thread: via the browser harness on lalala.talk, or via
 * `POST /__lalala/t3/settle` on the local app server. Returns true on success.
 */
export async function settleBrainThread(
  who: "user" | "brain" = "user",
  deps: SettleDeps = {},
): Promise<boolean> {
  const log =
    deps.log ??
    ((w: "user" | "brain", type: string, data: Record<string, unknown>) => {
      (
        globalThis as {
          __lalalaLog?: (who: string, type: string, data?: Record<string, unknown>) => void;
        }
      ).__lalalaLog?.(w, type, data);
    });
  const harnessSettle = deps.harnessSettle ?? globalThis.__lalalaAdapters?.harness?.settle;
  try {
    if (harnessSettle) {
      await harnessSettle();
    } else {
      const fetchFn = deps.fetchFn ?? fetch;
      const response = await fetchFn("/__lalala/t3/settle", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `settle answered ${response.status}`);
      }
    }
    log(who, "thread.settle", { ok: true });
    return true;
  } catch (error) {
    log(who, "thread.settle", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
