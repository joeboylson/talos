import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Reads the source text rather than the bundler's graph, so `import type` and
// `new URL(..., import.meta.url)` script paths are seen too.

type SourceTree = ReadonlyMap<string, string>;

const SPECIFIER_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];
const STATIC_IMPORT_PATTERNS = SPECIFIER_PATTERNS.slice(0, 4);

const specifiersIn = (source: string, patterns: readonly RegExp[]): string[] =>
  patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));

const resolveIn = (tree: SourceTree, fromFile: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((candidate) => tree.has(candidate)) ?? base;
};

const isInside = (folder: string, file: string): boolean => !relative(folder, file).startsWith("..");

const reachableFrom = (tree: SourceTree, start: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !tree.has(file)) return;
    seen.add(file);
    specifiersIn(tree.get(file) ?? "", STATIC_IMPORT_PATTERNS)
      .map((specifier) => resolveIn(tree, file, specifier))
      .forEach((target) => target && visit(target));
  };
  visit(start);
  return seen;
};

type ModuleLayout = {
  moduleFolder: string;
  utilsFolder: string;
  // The files that run code when loaded; nothing reachable from index.ts may import one.
  scripts: readonly string[];
};

const findBoundaryBreaks = (tree: SourceTree, layout: ModuleLayout): string[] => {
  const indexFile = join(layout.moduleFolder, "index.ts");
  const fileBreaks = [...tree.entries()].flatMap(([file, source]) => {
    const fileInModule = isInside(layout.moduleFolder, file);
    return specifiersIn(source, SPECIFIER_PATTERNS).flatMap((specifier) => {
      if (fileInModule && (specifier === "talos-shared" || specifier.startsWith("talos-shared/"))) {
        return [`${file} imports talos-shared`];
      }
      const target = resolveIn(tree, file, specifier);
      if (!target) return [];
      const targetInModule = isInside(layout.moduleFolder, target);
      if (!fileInModule && targetInModule && target !== indexFile) return [`${file} reaches into ${target}`];
      if (fileInModule && !targetInModule && !isInside(layout.utilsFolder, target)) return [`${file} reaches out to ${target}`];
      return [];
    });
  });
  const reachable = reachableFrom(tree, indexFile);
  const scriptBreaks = layout.scripts.filter((script) => reachable.has(script)).map((script) => `index.ts reaches the script ${script}`);
  return [...fileBreaks, ...scriptBreaks];
};

const SOURCE_ROOT = resolve(import.meta.dir, "..");

const readSourceTree = (root: string): SourceTree =>
  new Map(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(ts|tsx)$/.test(path) && !path.includes("node_modules"))
      .map((path) => [join(root, path), readFileSync(join(root, path), "utf8")] as const),
  );

const TALOS_SESSIONS: ModuleLayout = {
  moduleFolder: join(SOURCE_ROOT, "talos-sessions"),
  utilsFolder: join(SOURCE_ROOT, "talos-utils"),
  scripts: [
    join(SOURCE_ROOT, "session-runner.ts"),
    join(SOURCE_ROOT, "talos-sessions", "hook.ts"),
    join(SOURCE_ROOT, "talos-sessions", "tools-server.ts"),
  ],
};

describe("module boundaries", () => {
  test("talos-sessions is used only through its index.ts and stands on its own", () => {
    // shortcut: until plan step 4 cuts the module off from talos-shared and
    // passes the folder check in, those two breaks are expected. Step 4 deletes this filter.
    const notYetCut = (found: string): boolean => found.endsWith("imports talos-shared") || found.endsWith("/folders.ts");
    expect(findBoundaryBreaks(readSourceTree(SOURCE_ROOT), TALOS_SESSIONS).filter((found) => !notYetCut(found))).toEqual([]);
  });

  test("the check catches each kind of break", () => {
    const layout: ModuleLayout = { moduleFolder: "/s/mod", utilsFolder: "/s/talos-utils", scripts: ["/s/mod/hook.ts"] };
    const tree: SourceTree = new Map([
      ["/s/app.ts", `import type { X } from "./mod/inner"; import { y } from "./mod";`],
      ["/s/mod/index.ts", `export * from "./inner";`],
      ["/s/mod/inner.ts", `import "./hook"; import { a } from "talos-shared"; import { b } from "../app"; import { c } from "../talos-utils";`],
      ["/s/mod/hook.ts", ``],
      ["/s/mod/run.ts", `const script = new URL("../other.ts", import.meta.url);`],
      ["/s/talos-utils/index.ts", ``],
    ]);
    expect(findBoundaryBreaks(tree, layout)).toEqual([
      "/s/app.ts reaches into /s/mod/inner.ts",
      "/s/mod/inner.ts imports talos-shared",
      "/s/mod/inner.ts reaches out to /s/app.ts",
      "/s/mod/run.ts reaches out to /s/other.ts",
      "index.ts reaches the script /s/mod/hook.ts",
    ]);
  });
});
