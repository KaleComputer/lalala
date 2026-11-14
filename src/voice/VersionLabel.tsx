import { useEffect, useState } from "react";

type Version = { sha: string; dirty: boolean; at: string; host: string };

// Baked in at build time (site/version.mjs); the Vite dev server asks for it live instead.
const BAKED: Version | null = (() => {
  try {
    return JSON.parse(process.env.LALALA_VERSION ?? "null") as Version | null;
  } catch {
    return null;
  }
})();

const TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

function describe(v: Version) {
  const at = (Number.isNaN(Date.parse(v.at)) ? v.at : TIME.format(new Date(v.at))).replaceAll(" ", "\u00a0");
  return `${v.host} · ${v.sha}${v.dirty ? " + uncommitted" : ""} · ${at}`;
}

/** The quiet build stamp: where this runs, its commit and when it was built. Tapping copies it. */
export function VersionLabel(props: { readonly className?: string }) {
  const [version, setVersion] = useState(BAKED);
  const [copied, setCopied] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the dev server's HEAD moves under a running page; ask it per mount
  useEffect(() => {
    if (!import.meta.hot) return;
    let live = true;
    fetch("/__lalala-version", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Version>) : null))
      .then((next) => live && next && setVersion(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- "Copied" is a timed confirmation
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!version) return null;
  const text = describe(version);
  return (
    <button
      type="button"
      data-lalala-version=""
      className={props.className}
      title="Copy the version"
      aria-label={`Version: ${text}. Copy`}
      onClick={() =>
        void navigator.clipboard
          .writeText(`lalala ${text} (${version.at})`)
          .then(() => setCopied(true))
          .catch(() => {})
      }
    >
      {copied ? "Copied" : text}
    </button>
  );
}
