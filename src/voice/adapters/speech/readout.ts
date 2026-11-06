/** Messages a speech worker sends about its model. */
export type LoadMessage =
  | { readonly type: "load"; readonly name: string; readonly expected: number; readonly cached: boolean }
  | { readonly type: "progress"; readonly loaded: number; readonly total: number }
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly message: string };

/** Sums per-file progress events into one model's bytes. */
export function trackFiles(onBytes: (loaded: number, total: number) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if ((info.status !== undefined && info.status !== "progress") || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    onBytes(loaded, total);
  };
}
