// The app's Vite `?raw` imports, which the site's build gives the same meaning (next.config.mjs).
declare module "*?raw" {
  const text: string;
  export default text;
}

