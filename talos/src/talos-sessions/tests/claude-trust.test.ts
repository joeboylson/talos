import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTrusted, restoreTrust, restoreTrusted, trustFolder } from "../claude/claude-trust";

test("marks a new folder trusted and keeps everything else", () => {
  const claudeConfig = { theme: "dark", projects: { "/other": { lastCost: 1 } } };
  expect(markTrusted(claudeConfig, "/code/talos")).toEqual({
    theme: "dark",
    projects: { "/other": { lastCost: 1 }, "/code/talos": { hasTrustDialogAccepted: true } },
  });
});

test("keeps a known folder's other settings", () => {
  expect(markTrusted({ projects: { "/code/talos": { lastCost: 2 } } }, "/code/talos")).toEqual({
    projects: { "/code/talos": { lastCost: 2, hasTrustDialogAccepted: true } },
  });
});

test("an already trusted folder needs no change", () => {
  expect(markTrusted({ projects: { "/code/talos": { hasTrustDialogAccepted: true } } }, "/code/talos")).toBeNull();
});

test("works with no projects yet", () => {
  expect(markTrusted({}, "/code/talos")).toEqual({ projects: { "/code/talos": { hasTrustDialogAccepted: true } } });
});

describe("putting trust back", () => {
  test("only the one setting changes back, and everything else Claude Code keeps stays", () => {
    const config = { projects: { "/code/x": { lastCost: 2, hasTrustDialogAccepted: true } } };
    expect(restoreTrusted(config, { folderPath: "/code/x", before: undefined })).toEqual({ projects: { "/code/x": { lastCost: 2 } } });
    expect(restoreTrusted(config, { folderPath: "/code/x", before: false })).toEqual({ projects: { "/code/x": { lastCost: 2, hasTrustDialogAccepted: false } } });
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
    expect([...folders, dir].map((folder) => trusted.projects[realpathSync(folder)].hasTrustDialogAccepted)).toEqual([true, true, true, true, true]);
    await restoreTrust(changes.filter((change) => change !== null), configFile);
    const restored = JSON.parse(readFileSync(configFile, "utf8"));
    expect(restored.theme).toBe("dark");
    expect(restored.projects[realpathSync(dir)]).toEqual({ lastCost: 1 });
    expect(folders.map((folder) => restored.projects[realpathSync(folder)])).toEqual([{}, {}, {}, {}]);
    rmSync(dir, { recursive: true, force: true });
  });
});
