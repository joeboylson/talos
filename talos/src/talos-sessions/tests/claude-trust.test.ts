import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTrusted, restoreTrust, restoreTrusted, trustFolder } from "../claude/claude-trust";

const ANSWERED = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true, hasClaudeMdExternalIncludesApproved: false };

test("marks a new folder trusted, with outside CLAUDE.md imports left out, and keeps everything else", () => {
  const claudeConfig = { theme: "dark", projects: { "/other": { lastCost: 1 } } };
  expect(markTrusted(claudeConfig, "/code/talos")).toEqual({
    theme: "dark",
    projects: { "/other": { lastCost: 1 }, "/code/talos": ANSWERED },
  });
});

test("keeps a known folder's other settings", () => {
  expect(markTrusted({ projects: { "/code/talos": { lastCost: 2 } } }, "/code/talos")).toEqual({
    projects: { "/code/talos": { lastCost: 2, ...ANSWERED } },
  });
});

test("an outside-imports question someone already answered is left as they answered it", () => {
  const answered = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true, hasClaudeMdExternalIncludesApproved: true };
  expect(markTrusted({ projects: { "/code/talos": answered } }, "/code/talos")).toBeNull();
});

test("an already answered folder needs no change", () => {
  expect(markTrusted({ projects: { "/code/talos": ANSWERED } }, "/code/talos")).toBeNull();
});

test("works with no projects yet", () => {
  expect(markTrusted({}, "/code/talos")).toEqual({ projects: { "/code/talos": ANSWERED } });
});

describe("putting trust back", () => {
  test("only the settings changed go back, and everything else Claude Code keeps stays", () => {
    const config = { projects: { "/code/x": { lastCost: 2, ...ANSWERED } } };
    const before = { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesWarningShown: undefined, hasClaudeMdExternalIncludesApproved: undefined };
    expect(restoreTrusted(config, { folderPath: "/code/x", before, after: ANSWERED })).toEqual({ projects: { "/code/x": { lastCost: 2, hasTrustDialogAccepted: false } } });
  });

  test("an answer the person changed since is theirs, and stays", () => {
    const config = { projects: { "/code/x": { ...ANSWERED, hasClaudeMdExternalIncludesApproved: true } } };
    const before = { hasTrustDialogAccepted: undefined, hasClaudeMdExternalIncludesWarningShown: undefined, hasClaudeMdExternalIncludesApproved: undefined };
    expect(restoreTrusted(config, { folderPath: "/code/x", before, after: ANSWERED })).toEqual({ projects: { "/code/x": { hasClaudeMdExternalIncludesApproved: true } } });
  });

  test("several folders trusted at once all land, and all go back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "talos-trust-"));
    const configFile = join(dir, "claude.json");
    writeFileSync(configFile, JSON.stringify({ theme: "dark", projects: { [realpathSync(dir)]: { lastCost: 1 } } }));
    const folders = ["a", "b", "c", "d"].map((name) => {
      mkdirSync(join(dir, name));
      return join(dir, name);
    });
    const changes = await Promise.all([...folders, dir].map((folder) => trustFolder(folder, configFile)));
    const trusted = JSON.parse(readFileSync(configFile, "utf8"));
    expect([...folders, dir].map((folder) => trusted.projects[realpathSync(folder)].hasClaudeMdExternalIncludesApproved)).toEqual([false, false, false, false, false]);
    await restoreTrust(changes.filter((change) => change !== null), configFile);
    const restored = JSON.parse(readFileSync(configFile, "utf8"));
    expect(restored.theme).toBe("dark");
    expect(restored.projects[realpathSync(dir)]).toEqual({ lastCost: 1 });
    expect(folders.map((folder) => restored.projects[realpathSync(folder)])).toEqual([{}, {}, {}, {}]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the settings file", () => {
  const setUp = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "talos-trust-file-"));
    mkdirSync(join(dir, "work"));
    const configFile = join(dir, "claude.json");
    writeFileSync(configFile, text);
    return { dir, configFile, work: join(dir, "work") };
  };

  test("keeps its permissions, so a private file stays private", async () => {
    const { dir, configFile, work } = setUp("{}");
    chmodSync(configFile, 0o600);
    await trustFolder(work, configFile);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a link to it stays a link, and the file it points to gets the change", async () => {
    const { dir, configFile, work } = setUp("{}");
    const link = join(dir, "link.json");
    symlinkSync(configFile, link);
    await trustFolder(work, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(configFile, "utf8")).projects[realpathSync(work)]).toEqual(ANSWERED);
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["a list", "[1,2]"],
    ["projects that aren't a map", JSON.stringify({ projects: "ab" })],
    ["a project that isn't a map", JSON.stringify({ projects: { "/x": [1] } })],
    ["broken text", "{"],
  ])("settings that are %s aren't changed", async (_name, text) => {
    const { dir, configFile, work } = setUp(text);
    await expect(trustFolder(work, configFile)).rejects.toThrow();
    expect(readFileSync(configFile, "utf8")).toBe(text);
    rmSync(dir, { recursive: true, force: true });
  });
});
