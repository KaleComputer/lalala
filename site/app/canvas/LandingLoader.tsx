"use client";

import dynamic from "next/dynamic";

// The canvas reads its layout from localStorage, so it renders in the browser only; the static
// HTML keeps the headline for whoever reads it without JavaScript.
export const Landing = dynamic(() => import("./Landing"), {
  ssr: false,
  loading: () => <h1 data-landing-fallback="">talk to all your agents</h1>,
});
