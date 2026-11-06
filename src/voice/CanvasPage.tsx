import { SidebarInset } from "../components/ui/sidebar";
import { VoiceExtrasSlot } from "./VoiceExtrasSlot";

/** The canvas (/canvas): voice-made UI; the bar itself docks over every view (VoiceDock). */
export function CanvasPage() {
  return (
    <SidebarInset data-t3voice-page="" className="h-dvh min-h-0 overflow-hidden">
      <VoiceExtrasSlot />
    </SidebarInset>
  );
}
