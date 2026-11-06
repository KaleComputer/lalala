import { useRef, useState } from "react";

import type { DemoView, VoiceDemo } from "../demo";

const OFF: DemoView = { state: "off", message: null };

/**
 * lalala.talk's call: the in-browser demo (../demo), whose code and models load on the first tap.
 * Returns the shared VoiceBar's call props.
 */
export function useCall() {
  const demoRef = useRef<VoiceDemo | null>(null);
  const startingRef = useRef(false);
  const [view, setView] = useState<DemoView>(OFF);
  const [muted, setMuted] = useState(false);
  const live = view.state !== "off";

  const press = async () => {
    const running = demoRef.current;
    if (running !== null) {
      running.stop();
      demoRef.current = null;
      setMuted(false);
      setView(OFF);
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    setView({ state: "connecting", message: null });
    const { VoiceDemo } = await import("../demo").finally(() => (startingRef.current = false));
    const demo = new VoiceDemo((next) => {
      if (demoRef.current === demo) setView(next);
    });
    demoRef.current = demo;
    void demo.start();
  };

  return {
    state: view.state,
    message: view.message,
    disabled: false,
    label: live ? "End call" : "Start call",
    onPress: () => void press(),
    analysis: () => demoRef.current?.analysis() ?? null,
    onSubmit: async (text: string) => {
      demoRef.current?.ask(text);
      return true;
    },
    live,
    muted,
    onMute: () => {
      demoRef.current?.setMuted(!muted);
      setMuted(!muted);
    },
  };
}
