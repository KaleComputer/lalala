import type { Metadata } from "next";

export const metadata: Metadata = { title: "lalala", robots: { index: false } };

/** Pairing moved into the canvas's settings (Connection); old links land there. */
export default function ConnectPage() {
  return (
    <>
      <meta httpEquiv="refresh" content="0; url=/?connect" />
      <script dangerouslySetInnerHTML={{ __html: 'location.replace("/?connect")' }} />
    </>
  );
}
