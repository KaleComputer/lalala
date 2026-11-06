import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { Component, type ReactNode, useEffect, useState } from "react";

import "./extrasImages";
import { voiceLog } from "./voiceLog";
import "./voicePage.css";

type ExtrasModule = typeof import("./extras/VoiceExtras");
type Loaded = { readonly id: string; readonly module: ExtrasModule };

// Dev imports the source, so Vite's HMR updates it. Not a literal: the phone's main build must not
// bundle extras/, or every extras edit would rebuild and reload the whole app.
const DEV_ENTRY = "/src/voice/extras/VoiceExtras.tsx";
const BUILD = "/lalala-extras/build.json";
const POLL_MS = 2_000;

declare global {
  var __lalalaHost: Record<string, unknown> | undefined;
}

const importExtras = (url: string) => import(/* @vite-ignore */ url) as Promise<ExtrasModule>;

/** Loads a build's stylesheet next to the running one's; resolves once it applies. */
function loadStylesheet(id: string, css: boolean): Promise<HTMLLinkElement | null> {
  if (!css) return Promise.resolve(null);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/lalala-extras/extras.css?v=${id}`;
  link.dataset.lalalaExtras = "";
  const applied = new Promise<HTMLLinkElement>((resolve) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => resolve(link), { once: true });
  });
  document.head.append(link);
  return applied;
}

/** Keeps only `current` of the extras stylesheets. */
function keepStylesheet(current: HTMLLinkElement | null) {
  for (const link of document.querySelectorAll("link[data-lalala-extras]")) {
    if (link !== current) link.remove();
  }
}

/** Loads each newly published extras build (the phone's production build); returns a stop. */
function followPublishedExtras(onLoad: (loaded: Loaded) => void): () => void {
  globalThis.__lalalaHost = { react: React, "react/jsx-runtime": jsxRuntime };
  let stopped = false;
  let current: string | null = null;
  let failures = 0;
  let busy = false;
  async function check() {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const response = await fetch(BUILD, { cache: "no-store" });
      const build = response.ok ? ((await response.json()) as { id?: string; css?: boolean }) : {};
      const id = build.id;
      if (typeof id !== "string" || id === current) return;
      // Side by side, and the cards render styled: the corner is placed from the first frame.
      const sheet = loadStylesheet(id, build.css === true);
      // The browser keeps a failed module import for its URL, so a retry needs a new one.
      const retry = failures > 0 ? `&retry=${failures}` : "";
      const module = await importExtras(`/lalala-extras/extras.js?v=${id}${retry}`).catch(
        async (cause: unknown) => {
          failures += 1;
          (await sheet)?.remove();
          throw cause;
        },
      );
      failures = 0;
      const link = await sheet;
      if (stopped) return link?.remove();
      keepStylesheet(link);
      if (current !== null) voiceLog("system", "extras.swap", { id });
      current = id;
      onLoad({ id, module });
    } catch (cause) {
      voiceLog("system", "error", { where: "extras", message: String(cause) });
    } finally {
      busy = false;
    }
  }
  void check();
  const timer = window.setInterval(() => void check(), POLL_MS);
  document.addEventListener("visibilitychange", check);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", check);
  };
}

/**
 * The canvas's extras layer. On the phone's production build it loads extras/ as its own
 * bundle (extras.config.ts) and swaps in each newly published one, keeping the call running.
 */
export function VoiceExtrasSlot() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the extras module, and on the phone build follows its published build id
  useEffect(() => {
    if (!import.meta.env.DEV) return followPublishedExtras(setLoaded);
    let cancelled = false;
    void importExtras(DEV_ENTRY).then((module) => {
      if (!cancelled) setLoaded({ id: "dev", module });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loaded === null) return null;
  const { VoiceExtras } = loaded.module;
  return (
    <div data-lalala-extras="">
      <ExtrasBoundary key={loaded.id}>
        <VoiceExtras />
      </ExtrasBoundary>
    </div>
  );
}

// A broken extras build must not take the call down with it; the next build gets a fresh boundary.
class ExtrasBoundary extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    voiceLog("system", "error", { where: "extras", message: String(error) });
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
