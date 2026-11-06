import { CanvasMap } from "./CanvasMap";
import { CanvasSurface } from "./CanvasSurface";
import { StreamerToggle } from "./StreamerToggle";
import { VoiceClock } from "./VoiceClock";

/**
 * Voice-made UI, laid over the voice page. Import only React and files in this folder.
 * Cards pan and zoom on the surface; the corner stays fixed; the mini-map sits in the device bar.
 * The brain adds cards here, one line each:
 *   <CanvasCard id="..." title="..." at={{ x, y, w, h }}><YourThing /></CanvasCard>
 */
export function VoiceExtras() {
  return (
    <>
      <CanvasSurface>{null}</CanvasSurface>
      <div data-lalala-corner="">
        <StreamerToggle />
        <VoiceClock />
      </div>
      <CanvasMap />
    </>
  );
}
