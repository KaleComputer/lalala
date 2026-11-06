// The bar's UPDATE chip: callGuard holds a hot update that would reload the page until the call
// ends; the chip shows it is waiting, and tapping it reloads now.
import { markUpdateReady } from "./voice/phoneUpdate";

const LIVE = ["/src/voice/extras/", "/src/voice/extrasImages.ts", "/src/voice/voiceThemeSync.ts"];
const live = (path: string) => {
  const file = path.split("?")[0] ?? path;
  return file.endsWith(".css") || LIVE.some((prefix) => file.startsWith(prefix));
};
const callActive = () =>
  (document.querySelector<HTMLElement>("[data-t3voice-presence]")?.dataset.voiceState ?? "off") !==
  "off";

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", (payload) => {
    if (callActive() && payload.updates.some((update) => !live(update.path))) markUpdateReady();
  });
  import.meta.hot.on("vite:beforeFullReload", () => {
    if (callActive()) markUpdateReady();
  });
}
