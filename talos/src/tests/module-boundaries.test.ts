import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reads the source text rather than the bundler's graph, so `import type` and
// `new URL(..., import.meta.url)` script paths are seen too.

type SourceTree = ReadonlyMap<string, string>;

// Bun's own scanner finds every import and require however it's written
// (spaces, comments, options); `import type`, which it drops, is read by hand.
const scanner = new Bun.Transpiler({ loader: "tsx" });
const importsIn = (source: string): string[] => {
  const scanned = (() => {
    try {
      return scanner.scanImports(source).map(({ path }) => path);
    } catch {
      return [];
    }
  })();
  const typeOnly = [...source.matchAll(/\bimport\s+type\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  return [...scanned, ...typeOnly];
};
// Paths built to load or start code (a script's URL, a resolve): any written
// path, not only imports, so a spawned script counts too.
const PATH_TEXT = /["'`]((?:\.{1,2}|file:\/)?\/[^"'`\s]*)["'`]/g;
const withoutComments = (source: string): string => {
  try {
    return scanner.transformSync(source);
  } catch {
    return source;
  }
};
const pathTextsIn = (source: string): string[] => [...withoutComments(source).matchAll(PATH_TEXT)].map((match) => match[1]!).filter((path) => path.startsWith(".") || path.startsWith("file:") || path.startsWith("/.."));
// An import or script path built at run time can't be followed, so it isn't allowed.
const BUILT_IMPORT = /\b(?:import|require)\s*\((?!(?:\s|\/\*[\s\S]*?\*\/)*["'])|\bnew\s+URL\(\s*`|\b(?:import\.meta|require)\.resolve\(/;

const resolveIn = (tree: SourceTree, fromFile: string, specifier: string): string | null => {
  const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
  if (!path.startsWith(".") && !path.startsWith("/")) return null;
  const base = path.startsWith("/.") ? resolve(dirname(fromFile), `.${path}`) : resolve(dirname(fromFile), path);
  // Bun loads x.ts for an import of x.js.
  const asTs = base.replace(/\.(m|c)?js(x?)$/, ".$1ts$2");
  const candidates = [base, asTs, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((candidate) => tree.has(candidate)) ?? base;
};

const isInside = (folder: string, file: string): boolean => !relative(folder, file).startsWith("..");

const reachableFrom = (tree: SourceTree, start: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !tree.has(file)) return;
    seen.add(file);
    importsIn(tree.get(file) ?? "")
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
    const specifiers = [...new Set([...importsIn(source), ...(fileInModule ? pathTextsIn(source) : [])])];
    return specifiers.flatMap((specifier) => {
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
  const templateBreaks = [...tree.entries()].filter(([, source]) => BUILT_IMPORT.test(source)).map(([file]) => `${file} imports from a built path`);
  const reachable = reachableFrom(tree, indexFile);
  const scriptBreaks = layout.scripts.filter((script) => reachable.has(script)).map((script) => `index.ts reaches the script ${script}`);
  return [...new Set([...fileBreaks, ...templateBreaks, ...scriptBreaks])];
};

const SOURCE_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(SOURCE_ROOT, "../..");
const LIVE_CHECKS = join(REPO_ROOT, "dev/sessions");

// Every source file in the repo, so any program reaching in is seen. Left out:
// installed packages, build output, notes, and examples' run folders.
const SKIPPED = /(^|\/)(node_modules|\.git|ref|target|dist|run)(\/|$)/;
const SOURCE_FILE = /\.(m|c)?(t|j)sx?$/;
const sourcePaths = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => SOURCE_FILE.test(path) && !SKIPPED.test(path));
const readSourceTree = (root: string): SourceTree =>
  new Map(
    sourcePaths(root)
      // This file holds the patterns as text, so it's left out of its own scan.
      .filter((path) => join(root, path) !== import.meta.path && !lstatSync(join(root, path)).isSymbolicLink())
      .map((path) => [join(root, path), readFileSync(join(root, path), "utf8")] as const),
  );
// A link inside the module could load any file while looking like its own.
const linksIn = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((path) => !SKIPPED.test(path) && lstatSync(join(folder, path)).isSymbolicLink())
    .map((path) => `${join(folder, path)} is a link`);

const TALOS_SESSIONS: ModuleLayout = {
  moduleFolder: join(SOURCE_ROOT, "talos-sessions"),
  utilsFolder: join(SOURCE_ROOT, "talos-utils"),
  // The live checks do what a hostile session does (post to the link as its
  // mod, stall a reader), which no plain call offers.
  reachIns: {
    [LIVE_CHECKS]: [
      join(SOURCE_ROOT, "talos-sessions", "client", "runner-client.ts"),
      join(SOURCE_ROOT, "talos-sessions", "client", "runner-protocol.ts"),
      join(SOURCE_ROOT, "talos-sessions", "constants.ts"),
    ],
  },
  scripts: [
    join(SOURCE_ROOT, "session-runner.ts"),
  ],
};

describe("module boundaries", () => {
  test("talos-sessions is used only through its index.ts and stands on its own", () => {
    expect([...findBoundaryBreaks(readSourceTree(REPO_ROOT), TALOS_SESSIONS), ...linksIn(TALOS_SESSIONS.moduleFolder)]).toEqual([]);
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
      ["/s/mod/spaced.ts", `const a = await import ("../app"); const b = await import(/* c */ "../app", { with: {} }); import { j } from "../app.js";`],
      ["/s/mod/spawn.ts", `Bun.spawn([process.execPath, import.meta.dir + "/../app.ts"]); import x from "/s/app.ts";`],
      ["/s/mod/built.ts", "const u = new URL(`../app.ts`, import.meta.url); const r = import.meta.resolve(name);"],
      ["/s/server/reach.ts", `import { z } from "../mod/inner";`],
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
      "/s/mod/spaced.ts reaches out to /s/app.ts",
      "/s/mod/spawn.ts reaches out to /s/app.ts",
      "/s/mod/built.ts reaches out to /s/app.ts",
      "/s/server/reach.ts reaches into /s/mod/inner.ts",
      "/s/mod/examples/shop/main.ts reaches into /s/mod/inner.ts",
      "/s/mod/examples/shop/main.ts reaches into /s/mod/examples/other/view.ts",
      "/s/tool.ts imports from a built path",
      "/s/mod/built.ts imports from a built path",
      "index.ts reaches the script /s/mod/hook.ts",
    ]);
  });
});
