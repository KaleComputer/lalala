import type { ReactNode } from "react";
import { BrainCards } from "./BrainCards";
import { CanvasMap } from "./CanvasMap";
import { CanvasSurface } from "./CanvasSurface";
import "./look";
import "./looks/looks";

/**
 * Voice-made UI, laid over the voice page. Import only React and files in this folder.
 * Cards pan and zoom on the surface; the mini-map sits in the device bar.
 * The brain adds cards here, one line each:
 *   <CanvasCard id="..." title="..." at={{ x, y, w, h }}><YourThing /></CanvasCard>
 * `children` are a host's own cards (lalala.talk's), beside these and the brain's file cards.
 */
export function VoiceExtras(props: { readonly children?: ReactNode }) {
  return (
    <>
      <CanvasSurface>
        <BrainCards />
        {props.children}
      </CanvasSurface>
      <CanvasMap />
    </>
  );
}
