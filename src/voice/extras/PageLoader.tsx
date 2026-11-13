import { useEffect, useRef } from "react";

import { runLogo } from "./asciiLogo";
import "./pageLoader.css";

/**
 * The whole page's loading screen: the lalala mark turning as small white ASCII on black; when
 * `failed`, still turning but glitching, with "tap to retry". Moves only while `play` and on
 * screen. lalala's index.html shows the same before React (its own markup, the same runLogo).
 */
export function PageLoader(props: {
  readonly play: boolean;
  readonly failed?: boolean;
  readonly onReload?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLPreElement>(null);
  const play = props.play;
  const failed = props.failed ?? false;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the frame loop draws outside React, only while on screen
  useEffect(() => {
    const root = rootRef.current;
    const logo = logoRef.current;
    if (root === null || logo === null) return;
    const glitch = () => failed;
    let stop = runLogo(logo, () => true, glitch);
    if (!play) return;
    const observer = new IntersectionObserver(([entry]) => {
      stop();
      stop = runLogo(logo, entry?.isIntersecting ? undefined : () => true, glitch);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [play, failed]);

  return (
    <div data-lalala-page-loader="" data-failed={props.failed ? "" : undefined} ref={rootRef}>
      <pre ref={logoRef} aria-hidden="true" />
      {props.failed ? (
        <button type="button" onClick={props.onReload}>
          tap to retry
        </button>
      ) : null}
    </div>
  );
}
