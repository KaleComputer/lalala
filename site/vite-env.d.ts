// Vite's `?raw` imports, for the site's type check (site/tsconfig.json).
declare module "*?raw" {
  const text: string;
  export default text;
}


// Which host this build is (vite.config.mjs, from the mode): the app or lalala.talk.
interface ImportMetaEnv {
  readonly LALALA_HOST: "app" | "site";
  readonly LALALA_PORT: number;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob<T>(pattern: string | string[], options?: Record<string, unknown>): Record<string, T>;
}
