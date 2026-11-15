// lalala.talk's leak guard: `vite build --mode site` fails (so Vercel ships nothing) when the public
// build would carry something private. Two rules:
//   1. Every module in the bundle comes from this repo's public parts: src/, public/, index.html,
//      scripts/speech* or node_modules/. The user's cards (cards/, LALALA_CARDS_DIR, a brain folder like ~/dev/t3code),
//      .env and src/voice/brain.user.md are none of those, so pulling one in stops the build.
//   2. No emitted text file holds a secret-looking token, a home-folder path, or a value from .env.
// scripts/check.mjs runs the same text rules over the tracked files before a push.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Tokens that are never public: API keys, bot tokens, private keys. */
export const SECRET_PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["Infisical token", /\bst\.[a-f0-9-]{30,}\.[a-f0-9]{30,}/],
  ["Vercel token", /\bvercel_[A-Za-z0-9]{24,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
];

/** A path into someone's home folder: a build or a tracked file never needs one. */
export const HOME_PATH = /\/Users\/(?!runner\b|you\b|me\b|name\b|USER\b|<)[a-z][a-z0-9._-]{2,}\/|\/home\/(?!runner\b|user\b|you\b)[a-z][a-z0-9._-]{2,}\//;

/** Text files worth reading (models, audio and fonts are binary and skipped). */
export const TEXT_FILE = /\.(?:m?[jt]sx?|css|html?|json|md|txt|tsv|svg|map|ya?ml|py|sh|toml)$/i;

/** The values in a local .env (8+ characters), so none of them can end up in the build. */
export function envValues(root) {
  const file = NodePath.join(root, ".env");
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/)?.[1]?.trim().replace(/^["']|["']$/g, ""))
    .filter((value) => value && value.length >= 8);
}

/** What in `text` must not ship: a list of short reasons (never the matched value itself). */
export function findLeaks(text, env = []) {
  const found = [];
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) found.push(name);
  const home = text.match(HOME_PATH);
  if (home) found.push(`home-folder path ${home[0].replace(/\/Users\/[^/]+/, "/Users/…")}`);
  if (env.some((value) => text.includes(value))) found.push("a value from .env");
  return found;
}

// scripts/speech*: the Mac speech service, which lalala.talk writes to a paired computer (computerRoute.ts).
const PUBLIC_PARTS = ["src/", "public/", "index.html", "node_modules/", "scripts/speech/", "scripts/speech.sh"];

export function leakGuardPlugin({ root }) {
  const repo = NodePath.resolve(root);
  const env = envValues(repo);
  return {
    name: "lalala-leak-guard",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const problems = [];
      for (const item of Object.values(bundle)) {
        for (const id of item.type === "chunk" ? Object.keys(item.modules) : []) {
          if (id.startsWith("\0") || id.startsWith("virtual:")) {
            if (id.includes("lalala-cards")) problems.push(`${item.fileName}: the user's cards (${id.replace("\0", "")})`);
            continue;
          }
          const file = id.split("?")[0];
          // A package, wherever the installer put it (a symlinked or hoisted node_modules too).
          if (file.split(NodePath.sep).includes("node_modules")) continue;
          const relative = NodePath.relative(repo, file).split(NodePath.sep).join("/");
          const outside = relative.startsWith("..") || NodePath.isAbsolute(relative);
          if (outside || !PUBLIC_PARTS.some((part) => relative === part || relative.startsWith(part)))
            problems.push(`${item.fileName}: module from outside the public parts (${outside ? "outside this repo" : relative})`);
          else if (relative === "src/voice/brain.user.md") problems.push(`${item.fileName}: the user's own brain rules`);
        }
        if (!TEXT_FILE.test(item.fileName)) continue;
        const text = item.type === "chunk" ? item.code : typeof item.source === "string" ? item.source : null;
        if (text === null) continue;
        for (const leak of findLeaks(text, env)) problems.push(`${item.fileName}: ${leak}`);
      }
      if (problems.length > 0)
        this.error(
          `lalala.talk would ship private things, so the build stops (vite/leakGuard.mjs):\n  ${[...new Set(problems)].join("\n  ")}`,
        );
    },
  };
}
