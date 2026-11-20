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
// An import built from a template can't be followed, so it isn't allowed.
const TEMPLATE_IMPORT = /\bimport\(\s*`/;

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
  // Files outside the module allowed to reach into it on purpose, by folder.
  reachIns: Readonly<Record<string, readonly string[]>>;
  // The files that run code when loaded; nothing reachable from index.ts may import one.
  scripts: readonly string[];
};

const findBoundaryBreaks = (tree: SourceTree, layout: ModuleLayout): string[] => {
  const indexFile = join(layout.moduleFolder, "index.ts");
  // An example uses the module only through index.ts, plus the kit and its own files.
  const examplesFolder = join(layout.moduleFolder, "examples");
  const kitFolder = join(examplesFolder, "kit");
  const exampleOf = (file: string): string | null =>
    isInside(examplesFolder, file) && !isInside(kitFolder, file) ? (relative(examplesFolder, file).split("/")[0] ?? null) : null;
  const fileBreaks = [...tree.entries()].flatMap(([file, source]) => {
    const fileInModule = isInside(layout.moduleFolder, file);
    return specifiersIn(source, SPECIFIER_PATTERNS).flatMap((specifier) => {
      if (fileInModule && (specifier === "talos-shared" || specifier.startsWith("talos-shared/"))) {
        return [`${file} imports talos-shared`];
      }
      const target = resolveIn(tree, file, specifier);
      if (!target) return [];
      const targetInModule = isInside(layout.moduleFolder, target);
      const isAllowedReachIn = Object.entries(layout.reachIns).some(
        ([folder, targets]) => isInside(folder, file) && targets.includes(target),
      );
      if (!fileInModule && targetInModule && target !== indexFile && !isAllowedReachIn) return [`${file} reaches into ${target}`];
      if (exampleOf(file) && targetInModule && target !== indexFile && !isInside(kitFolder, target) && exampleOf(target) !== exampleOf(file)) {
        return [`${file} reaches into ${target}`];
      }
      if (fileInModule && !targetInModule && !isInside(layout.utilsFolder, target)) return [`${file} reaches out to ${target}`];
      return [];
    });
  });
  const templateBreaks = [...tree.entries()].filter(([, source]) => TEMPLATE_IMPORT.test(source)).map(([file]) => `${file} imports from a template`);
  const reachable = reachableFrom(tree, indexFile);
  const scriptBreaks = layout.scripts.filter((script) => reachable.has(script)).map((script) => `index.ts reaches the script ${script}`);
  return [...fileBreaks, ...templateBreaks, ...scriptBreaks];
};

const SOURCE_ROOT = resolve(import.meta.dir, "..");
const LIVE_CHECKS = resolve(SOURCE_ROOT, "../../dev/sessions");

const readSourceTree = (root: string): SourceTree =>
  new Map(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(ts|tsx)$/.test(path) && !path.includes("node_modules"))
      .map((path) => [join(root, path), readFileSync(join(root, path), "utf8")] as const),
  );

const TALOS_SESSIONS: ModuleLayout = {
  moduleFolder: join(SOURCE_ROOT, "talos-sessions"),
  utilsFolder: join(SOURCE_ROOT, "talos-utils"),
  // The live checks do what a hostile session does (forge hooks, flood the
  // hooks socket, stall a reader), which no plain call offers.
  reachIns: {
    [LIVE_CHECKS]: [
      join(SOURCE_ROOT, "talos-sessions", "client", "hook-client.ts"),
      join(SOURCE_ROOT, "talos-sessions", "client", "runner-client.ts"),
      join(SOURCE_ROOT, "talos-sessions", "client", "runner-protocol.ts"),
      join(SOURCE_ROOT, "talos-sessions", "constants.ts"),
    ],
  },
  scripts: [
    join(SOURCE_ROOT, "session-runner.ts"),
    join(SOURCE_ROOT, "talos-sessions", "hook.ts"),
    join(SOURCE_ROOT, "talos-sessions", "tools-server.ts"),
  ],
};

describe("module boundaries", () => {
  test("talos-sessions is used only through its index.ts and stands on its own", () => {
    const tree = new Map([...readSourceTree(SOURCE_ROOT), ...readSourceTree(LIVE_CHECKS)]);
    expect(findBoundaryBreaks(tree, TALOS_SESSIONS)).toEqual([]);
  });

  test("the check catches each kind of break", () => {
    const layout: ModuleLayout = { moduleFolder: "/s/mod", utilsFolder: "/s/talos-utils", reachIns: { "/s/dev": ["/s/mod/inner.ts"] }, scripts: ["/s/mod/hook.ts"] };
    const tree: SourceTree = new Map([
      ["/s/app.ts", `import type { X } from "./mod/inner"; import { y } from "./mod";`],
      ["/s/mod/index.ts", `export * from "./inner";`],
      ["/s/mod/inner.ts", `import "./hook"; import { a } from "talos-shared"; import { b } from "../app"; import { c } from "../talos-utils";`],
      ["/s/mod/hook.ts", ``],
      ["/s/mod/run.ts", `const script = new URL("../other.ts", import.meta.url);`],
      ["/s/talos-utils/index.ts", ``],
      ["/s/dev/check.ts", `import { a } from "../mod/inner"; import { b } from "../mod/run";`],
      // Split, so this file doesn't match its own check.
      ["/s/tool.ts", "const m = await imp" + "ort(`./mod/${name}`);"],
      ["/s/mod/examples/kit/view.ts", `import { x } from "../../index";`],
      ["/s/mod/examples/shop/main.ts", `import { v } from "./view"; import { k } from "../kit/view"; import { i } from "../../inner"; import { o } from "../other/view";`],
      ["/s/mod/examples/shop/view.ts", ``],
      ["/s/mod/examples/other/view.ts", ``],
    ]);
    expect(findBoundaryBreaks(tree, layout)).toEqual([
      "/s/app.ts reaches into /s/mod/inner.ts",
      "/s/mod/inner.ts imports talos-shared",
      "/s/mod/inner.ts reaches out to /s/app.ts",
      "/s/mod/run.ts reaches out to /s/other.ts",
      "/s/dev/check.ts reaches into /s/mod/run.ts",
      "/s/mod/examples/shop/main.ts reaches into /s/mod/inner.ts",
      "/s/mod/examples/shop/main.ts reaches into /s/mod/examples/other/view.ts",
      "/s/tool.ts imports from a template",
      "index.ts reaches the script /s/mod/hook.ts",
    ]);
  });
});
