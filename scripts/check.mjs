#!/usr/bin/env node
// `npm run check`: what has to hold before main is pushed, since a push to main is a lalala.talk
// deploy (Vercel builds site/ → `vite build --mode site`). The .githooks/pre-push hook runs it.
//   1. No tracked file is private: no cards/, .env or brain.user.md, no secret-looking token, no
//      home-folder path (vite/leakGuard.mjs's rules; this repo is public on GitHub).
//   2. The site typechecks (Vercel's build starts with it; a failure there ships nothing, silently).
//   3. The site builds, with the leak guard on, into a temp folder (site/out stays untouched).
//   Before 2 and 3: barge-in on recorded speech (scripts/barge-in), which broke silently too often.
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { TEXT_FILE, envValues, findLeaks } from "../vite/leakGuard.mjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const step = (name) => console.log(`\n· ${name}`);

// Paths that never belong in this repo, whatever they hold.
const PRIVATE_PATH = /(^|\/)(cards\/|\.env$|\.env\.local$|\.lalala\/|brain\.user\.md$)/;
// Files allowed to mention a home path or a token pattern: this guard's own rules and docs.
const SELF = new Set(["vite/leakGuard.mjs", "scripts/check.mjs"]);

step("tracked files hold nothing private");
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  .toString()
  .split("\0")
  .filter(Boolean);
const env = envValues(root);
const problems = [];
for (const file of files) {
  if (PRIVATE_PATH.test(file)) problems.push(`${file}: private path`);
  if (SELF.has(file) || !TEXT_FILE.test(file)) continue;
  const full = NodePath.join(root, file);
  if (!NodeFS.existsSync(full) || NodeFS.statSync(full).size > 8_000_000) continue;
  for (const leak of findLeaks(NodeFS.readFileSync(full, "utf8"), env)) problems.push(`${file}: ${leak}`);
}
if (problems.length > 0) {
  console.error(`private things in the repo, fix before pushing:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`  ${files.length} files clean`);

step("barge-in holds for Tim, never for noise or echo (scripts/barge-in)");
run(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "scripts/barge-in/check.test.mjs"]);

if (!process.argv.includes("--files-only")) {
  step("site typechecks (as on Vercel)");
  const site = NodePath.join(root, "site");
  if (!NodeFS.existsSync(NodePath.join(site, "node_modules"))) run("npm", ["ci", "--no-audit", "--no-fund"], site);
  run("npm", ["run", "--silent", "typecheck"], site);

  step("site builds with the leak guard");
  const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-site-"));
  try {
    run("npx", ["vite", "build", "--mode", "site", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"]);
  } finally {
    NodeFS.rmSync(out, { recursive: true, force: true });
  }
}
console.log("\nok: safe to push (a push to main deploys lalala.talk)");
