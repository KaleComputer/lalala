// Standalone: one page, the canvas.
const location = { pathname: "/canvas" };
export function useLocation<T = typeof location>(options?: { select?: (l: typeof location) => T }): T {
  return (options?.select ? options.select(location) : location) as T;
}
export const useNavigate = () => () => {};
