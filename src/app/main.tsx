// The app's host (src/main.tsx): the canvas (CanvasPage), its device bar (VoiceDock) and the canvas switcher. The bar is
// always open: hiding it would leave an empty page with nothing to go back to.
import "../storageMigration";
import "@fontsource-variable/inter";
import "../index.css";
import "../voice/callGuard";
// Before the first render, so the brain's bridge registers every control as it mounts.
import "../voice/uiBridge";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { installAdapters } from "../voice/adapters";
import { serverStorage } from "../voice/adapters/storage/server";
import { CanvasPage } from "../voice/CanvasPage";
import { CanvasSwitcher } from "../voice/CanvasSwitcher";
import { StreamerFilter } from "../voice/streamerMode";
import { VoiceDock } from "../voice/VoiceDock";
import { setVoiceOpen } from "../voice/voiceOpen";

// The user's own brain rules, appended to the brief (brief.ts); a glob, so a missing file is fine.
globalThis.__lalalaUserRules = Object.values(
  import.meta.glob<string>("../voice/brain.user.md", { query: "?raw", import: "default", eager: true }),
)[0];

// The app keeps layout and settings on its server; lalala.talk installs the browser adapters.
installAdapters({
  storage: serverStorage,
  readFile: (relativePath) =>
    fetch(`/__lalala/brain-file?path=${encodeURIComponent(relativePath)}`, { cache: "no-store" }).then(
      (response) => (response.ok ? response.text() : null),
    ),
});

// The /canvas route opens the bar on entry (routes/_chat.canvas.tsx).
setVoiceOpen(true);

function App() {
  return (
    <>
      <div className="flex h-dvh min-h-0 w-full">
        <CanvasPage />
      </div>
      <div
        className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center gap-1"
        data-sidebar-control=""
      >
        <CanvasSwitcher />
      </div>
      <VoiceDock />
      <StreamerFilter />
      <ConfirmDialogHost />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
