import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashModFiles, prepareModFiles, snapshotMod } from "../runner/mod-snapshot";
import { MOD_FOLDER } from "../constants";
import { pinClaudeCode } from "../claude/pinned-claude";

const scratch = mkdtempSync(join(tmpdir(), "talos-snapshot-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fileOf = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text) });
const MANIFEST = fileOf(".claude-plugin/plugin.json", '{ "name": "talos" }');

test("a snapshot leaves out the mod's tests and editor types, and pins its engines range", () => {
  const prepared = prepareModFiles([fileOf("tests/a.test.ts", ""), fileOf(".claude-plugin/types/x.d.ts", ""), fileOf("hooks/register.ts", "x"), MANIFEST], "9.9.9");
  expect(prepared.map(({ path }) => path)).toEqual([".claude-plugin/plugin.json", "hooks/register.ts"]);
  expect(JSON.parse(new TextDecoder().decode(prepared[0]!.content))).toEqual({ name: "talos", engines: { "claude-code": "9.9.9" } });
});

test("the hash changes with any file's name or content, and not with their order", () => {
  const files = [fileOf("a", "1"), fileOf("b", "2")];
  expect(hashModFiles(files)).toBe(hashModFiles(prepareModFiles(files.toReversed(), "1")));
  expect(hashModFiles(files)).not.toBe(hashModFiles([fileOf("a", "1"), fileOf("b", "3")]));
  expect(hashModFiles(files)).not.toBe(hashModFiles([fileOf("a", "1"), fileOf("c", "2")]));
  expect(hashModFiles([fileOf("ab", "")])).not.toBe(hashModFiles([fileOf("a", "b")]));
});

test("the real mod snapshots read-only, once per hash, and an older one goes", () => {
  const snapshots = join(scratch, "mod");
  const first = snapshotMod(MOD_FOLDER, snapshots, "9.9.9");
  expect(statSync(join(first.folder, "hooks", "register.ts")).mode & 0o777).toBe(0o444);
  expect(snapshotMod(MOD_FOLDER, snapshots, "9.9.9")).toEqual(first);
  const second = snapshotMod(MOD_FOLDER, snapshots, "9.9.8");
  expect(second.hash).not.toBe(first.hash);
  expect(existsSync(first.folder)).toBe(false);
  expect(JSON.parse(readFileSync(join(second.folder, ".claude-plugin", "plugin.json"), "utf8")).engines).toEqual({ "claude-code": "9.9.8" });
});

// Stand-ins that print a version, as `claude --version` does.
const standIn = (name: string, version: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return path;
};

test("the pinned Claude Code is made from the first candidate that is its version, and kept", () => {
  const pinnedFolder = join(scratch, "claude-code");
  const wrong = standIn("claude-wrong", "1.0.0");
  const right = standIn("claude-right", "2.0.0");
  expect(pinClaudeCode(pinnedFolder, "3.0.0", [null, wrong, right])).toBeNull();
  const pinned = pinClaudeCode(pinnedFolder, "2.0.0", [null, join(scratch, "gone"), wrong, right]);
  expect(pinned).toBe(join(pinnedFolder, "2.0.0", "claude"));
  expect(statSync(pinned!).ino).toBe(statSync(right).ino);
  rmSync(right);
  expect(pinClaudeCode(pinnedFolder, "2.0.0", [])).toBe(pinned);
});
