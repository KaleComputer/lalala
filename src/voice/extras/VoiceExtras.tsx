import type { ReactNode } from "react";
import { TemplateCards } from "../templates/TemplateCards";
import { AgentMonitorCard } from "./AgentMonitorCard";
import { BrainCards } from "./BrainCards";
import { CanvasMap } from "./CanvasMap";
import { CanvasSurface } from "./CanvasSurface";
import { StarterCard } from "./StarterCard";
import "./look";
import "./looks/looks";

/**
 * Voice-made UI, laid over the voice page. Import only React and files in this folder.
 * Cards pan and zoom on the surface; the mini-map sits in the device bar.
 * The brain adds cards here, one line each:
 *   <CanvasCard id="..." title="..." at={{ x, y, w, h }}><YourThing /></CanvasCard>
 * `children` are a host's own cards (lalala.talk's), beside these and the brain's file cards.
 */
export function VoiceExtras(props: {
  readonly children?: ReactNode;
  /** Auto-mount the Starter Selector when Main has 0 cards (on in the local app, off on lalala.talk). */
  readonly starter?: boolean;
}) {
  const starter = props.starter ?? import.meta.env?.LALALA_HOST !== "site";
  return (
    <>
      <CanvasSurface>
        <AgentMonitorCard />
        <BrainCards />
        <TemplateCards />
        {props.children}
        <StarterCard enabled={starter} />
      </CanvasSurface>
      <CanvasMap />
    </>
  );
}
