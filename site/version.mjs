// Which build this is, baked into the page as process.env.LALALA_VERSION (next.config.mjs,
// vite.config.mjs) and read by src/voice/VersionLabel.tsx. The dev server also serves it live at
// /__lalala-version, so the label follows commits without a restart.
import { execFileSync } from "node:child_process";

const git = (root, ...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** `host` names where it runs ("lalala.talk", "local dev"); `at` is the build time, or HEAD's in dev. */
export function buildVersion(root, host) {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const sha = vercel || git(root, "rev-parse", "HEAD") || "unknown";
  // Uncommitted edits to the app's own code, tracked or new; Vercel builds a commit as it is.
  const dirty =
    !vercel && git(root, "status", "--porcelain", "--", "src", "site/app", "vite", "index.html") !== "";
  const at = host === "local dev" ? git(root, "log", "-1", "--format=%cI") : new Date().toISOString();
  return { sha: sha.slice(0, 7), dirty, at: at || new Date().toISOString(), host };
}
