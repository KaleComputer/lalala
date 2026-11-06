import { useEffect, useState } from "react";
import "./voiceClock.css";

const formatTime = (date: Date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A small wall clock in the page's top right corner; it repaints once a second and never takes clicks. */
export function VoiceClock() {
  const [now, setNow] = useState(() => new Date());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock, re-armed on each second boundary
  useEffect(() => {
    const untilNextSecond = () => 1000 - (Date.now() % 1000);
    const tick = () => {
      setNow(new Date());
      id = window.setTimeout(tick, untilNextSecond());
    };
    let id = window.setTimeout(tick, untilNextSecond());
    return () => window.clearTimeout(id);
  }, []);
  return (
    <time data-t3voice-clock="" dateTime={now.toISOString()}>
      {formatTime(now)}
    </time>
  );
}
