// Modules that apply their own hot update without remounting the voice host.
const LIVE = ["/src/voice/extras/", "/src/voice/extrasImages.ts", "/src/voice/voiceThemeSync.ts"];

/**
 * Whether a hot update applies in place during a call: CSS, extras/ and the user's cards (served
 * under `cardsUrl`, vite/cards.mjs). Anything else is a change to lalala's own code.
 */
export function appliesLive(path: string, cardsUrl: string | undefined): boolean {
  const file = path.split("?")[0] ?? path;
  return (
    file.endsWith(".css") ||
    LIVE.some((prefix) => file.startsWith(prefix)) ||
    (cardsUrl !== undefined && file.startsWith(cardsUrl))
  );
}
