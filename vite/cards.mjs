// The user's own cards, in the brain's folder (`<brain project>/cards`, or LALALA_CARDS_DIR), not in
// this repo: `cards/index.tsx` is mounted on the canvas as `virtual:lalala-cards`, hot-reloading
// like the rest. A card imports lalala's canvas files (`./CanvasCard`, `./cutFrame.css`, …) as if it
// sat in src/voice/extras: a path that isn't in the cards folder resolves there. `cards/server/*.mjs`
// may add dev-server routes (each default-exports a Vite plugin); they run in this app only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

const ID = "virtual:lalala-cards";
const RESOLVED = `\0${ID}`;
const ENTRIES = ["index.tsx", "index.jsx", "index.ts", "index.js"];

export const cardsDir = (brainRoot) =>
  NodePath.resolve(process.env.LALALA_CARDS_DIR?.trim() || NodePath.join(brainRoot, "cards"));

const entryOf = (dir) =>
  ENTRIES.map((name) => NodePath.join(dir, name)).find((file) => NodeFS.existsSync(file)) ?? null;

const inside = (dir, file) => {
  const relative = NodePath.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const CODE = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
const IMPORT = /^import\s+(?!type\b)(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*(["'])(\.[^"']+)\3;?[ \t]*$/gm;

/**
 * The entry's card components as lazy ones (extras/lazyCard.tsx): `import { Board } from "./Board"`
 * becomes a fetch of ./Board the first time a card shows a <Board />. Only imports of the cards
 * folder's own files whose every binding is used just as a JSX tag; anything else stays as written.
 */
export function lazyCardImports(code, dir, from, lazyCardFile) {
  const ownFile = (spec) => {
    const base = NodePath.resolve(NodePath.dirname(from), spec);
    return inside(dir, base) && CODE.some((ext) => NodeFS.statSync(base + ext, { throwIfNoEntry: false })?.isFile());
  };
  const body = code.replace(IMPORT, "");
  const tagOnly = (name) =>
    /^[A-Z]/.test(name) &&
    new RegExp(`<${name}[\\s/>]`).test(body) &&
    !new RegExp(`(?<![<\\w$.])${name}(?![\\w$])`).test(body.replace(new RegExp(`</?${name}(?![\\w$])`, "g"), ""));
  let count = 0;
  const out = code.replace(IMPORT, (statement, fallback, named, _q, spec) => {
    if (!ownFile(spec)) return statement;
    const bindings = [
      ...(fallback ? [{ imported: "default", local: fallback }] : []),
      ...(named ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "))
        .map((part) => {
          const [imported, local = imported] = part.split(/\s+as\s+/);
          return { imported, local };
        }),
    ];
    if (bindings.length === 0 || !bindings.every((binding) => tagOnly(binding.local))) return statement;
    const load = `__lalalaCard${count++}`;
    return [
      `const ${load} = () => import(${JSON.stringify(spec)});`,
      ...bindings.map(
        ({ imported, local }) => `const ${local} = __lalalaLazyCard(${load}, ${JSON.stringify(imported)});`,
      ),
    ].join(" ");
  });
  return count === 0
    ? null
    : `import { lazyCard as __lalalaLazyCard } from ${JSON.stringify(lazyCardFile)};\n${out}`;
}

export function cardsPlugin({ dir, extrasDir }) {
  let entry = entryOf(dir);
  const lazyCards = {
    name: "lalala-cards-lazy",
    // Before the JSX transform, which would hide the tags.
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!inside(dir, file)) return null;
      // Vite makes `new URL(`./${name}`, import.meta.url)` an eager glob of every file in the
      // folder, one request each (thousands here): the card resolves it when it runs instead.
      const out = code.replace(/\bnew\s+URL\s*\(\s*(?=`[^`]*\$\{)/g, "$&/* @vite-ignore */ ");
      const lazy =
        file === entry ? lazyCardImports(out, dir, entry, NodePath.join(extrasDir, "lazyCard.tsx")) : null;
      return lazy !== null ? { code: lazy, map: null } : out !== code ? { code: out, map: null } : null;
    },
  };
  return [lazyCards, {
    name: "lalala-cards",
    config: () => ({
      server: { fs: { allow: [NodePath.resolve(import.meta.dirname, ".."), dir] } },
      // One React for the page and the cards, wherever the cards folder's own node_modules point.
      resolve: { dedupe: ["react", "react-dom"] },
    }),
    resolveId(source, importer) {
      if (source === ID) return RESOLVED;
      if (!importer || !source.startsWith(".")) return null;
      const from = importer.split("?")[0];
      if (!inside(dir, from)) return null;
      const target = NodePath.resolve(NodePath.dirname(from), source.split("?")[0]);
      const query = source.includes("?") ? source.slice(source.indexOf("?")) : "";
      return this.resolve(source, importer, { skipSelf: true }).then(
        (own) =>
          own ??
          this.resolve(NodePath.join(extrasDir, NodePath.relative(dir, target)) + query, importer, {
            skipSelf: true,
          }),
      );
    },
    load(id) {
      if (id !== RESOLVED) return null;
      // Where the cards' modules are served, so a call keeps taking their hot updates (callGuard.ts).
      const url = `globalThis.__lalalaCardsUrl = ${JSON.stringify(`/@fs${dir}/`)};\n`;
      return entry
        ? `${url}export { default } from ${JSON.stringify(entry)};`
        : `${url}export default null;`;
    },
    configureServer(server) {
      // A card file the brain wrote, for its `[card …]` tag (brainCards.ts): only inside the cards folder.
      server.middlewares.use("/__lalala/brain-file", (req, res) => {
        const path = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
        const file = NodePath.resolve(dir, path.replace(/^cards\//, ""));
        const stat = inside(dir, file) ? NodeFS.statSync(file, { throwIfNoEntry: false }) : undefined;
        if (!stat?.isFile() || stat.size > 1024 * 1024) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(NodeFS.readFileSync(file));
      });
      server.watcher.add(dir);
      const recheck = (file) => {
        if (NodePath.dirname(file) !== dir || !ENTRIES.includes(NodePath.basename(file))) return;
        const next = entryOf(dir);
        if (next === entry) return;
        entry = next;
        const module = server.moduleGraph.getModuleById(RESOLVED);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", recheck);
      server.watcher.on("unlink", recheck);
    },
  }];
}

/** The cards folder's own dev-server routes, `cards/server/*.mjs`; none when it has no such folder. */
export async function cardServerPlugins(dir) {
  const serverDir = NodePath.join(dir, "server");
  if (!NodeFS.existsSync(serverDir)) return [];
  const files = NodeFS.readdirSync(serverDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const plugins = [];
  for (const name of files) {
    const module = await import(pathToFileURL(NodePath.join(serverDir, name)).href);
    const made = typeof module.default === "function" ? module.default() : module.default;
    if (made) plugins.push(made);
  }
  return plugins;
}
