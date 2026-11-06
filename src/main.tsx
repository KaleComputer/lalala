// lalala: the canvas (CanvasPage), its device bar (VoiceDock) and the canvas switcher. The bar is
// always open: hiding it would leave an empty page with nothing to go back to.
import "@fontsource-variable/inter";
import "./index.css";
import "./updateChip";
import "./voice/callGuard";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { TooltipProvider } from "./components/ui/tooltip";
import { installAdapters } from "./voice/adapters";
import { serverStorage } from "./voice/adapters/storage/server";
import { CanvasPage } from "./voice/CanvasPage";
import { CanvasSwitcher } from "./voice/CanvasSwitcher";
import { StreamerFilter } from "./voice/streamerMode";
import { VoiceDock } from "./voice/VoiceDock";
import { setVoiceOpen } from "./voice/voiceOpen";

// The app keeps layout and settings on its server; lalala.talk installs the browser adapters.
installAdapters({ storage: serverStorage });

// The /canvas route opens the bar on entry (routes/_chat.canvas.tsx).
setVoiceOpen(true);

function App() {
  return (
    <TooltipProvider>
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
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
