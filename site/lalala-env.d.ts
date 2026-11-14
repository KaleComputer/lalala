// The page's HMR hooks, for the site's type check (site/tsconfig.json); a build has none.
interface ImportMeta {
  readonly hot?: { accept(): void; dispose(callback: () => void): void };
}
