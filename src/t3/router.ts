// Standalone: one page, the canvas. A thread route opens that thread in the T3 Code app instead.
const location = { pathname: "/canvas" };
export function useLocation<T = typeof location>(options?: { select?: (l: typeof location) => T }): T {
  return (options?.select ? options.select(location) : location) as T;
}

// The real environment id (the bridge's ENVIRONMENT_ID is a stand-in), read once from the paired
// T3 server, so a click can hand the desktop app its deep link synchronously.
let environmentId: string | null = null;
let loading: Promise<void> | null = null;
function loadEnvironmentId(): void {
  loading ??= (async () => {
    try {
      const connection = (await (await fetch("/__t3voice/t3/connection")).json()) as {
        origin?: string | null;
      };
      if (!connection.origin) return;
      const descriptor = (await (
        await fetch(new URL("/.well-known/t3/environment", connection.origin))
      ).json()) as { environmentId?: string };
      environmentId = descriptor.environmentId ?? null;
    } catch {
      // Not paired or not reachable from this device: the next navigation asks again.
    } finally {
      if (environmentId === null) loading = null;
    }
  })();
}

type Navigation = { readonly to?: string; readonly params?: { readonly threadId?: string } };

const navigate = (options?: Navigation) => {
  const threadId = options?.to === "/$environmentId/$threadId" ? options.params?.threadId : undefined;
  if (threadId === undefined) return;
  if (environmentId === null) return loadEnvironmentId();
  // T3 Code's desktop deep link; the app decodes the path segment back into the thread id.
  window.location.href = `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
};

export const useNavigate = () => {
  loadEnvironmentId();
  return navigate;
};
