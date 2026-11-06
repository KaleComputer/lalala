import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

const description =
  "lalala is a voice-first canvas for coding agents. You talk, an agent brain answers out loud, hands real work to coding agents and builds what you need on an endless canvas. Speech stays on your Mac.";

export const metadata: Metadata = {
  metadataBase: new URL("https://lalala.talk"),
  title: "lalala — talk to all your agents",
  description,
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
  openGraph: {
    title: "lalala — talk to all your agents",
    description: "A voice-first canvas for coding agents. Open source, local speech.",
    url: "https://lalala.talk",
    siteName: "lalala",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0908",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/oxanium-var-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/geist-400-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
