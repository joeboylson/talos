import { expect, test } from "bun:test";
import { HELP_TEXT, isFolderCommand, isSessionCommand, parseCommand } from "../../commands";
import { realFolderPath, resolveFolderPath } from "../../folder-commands";

test("no command connects", () => {
  expect(parseCommand([])).toEqual({ name: "connect" });
});

test("help shows the list", () => {
  expect(parseCommand(["help"])).toEqual({ name: "help" });
});

test("folder commands", () => {
  expect(parseCommand(["folders"])).toEqual({ name: "folders-list" });
  expect(parseCommand(["folders", "add", "~/code/talos"])).toEqual({ name: "folders-add", path: "~/code/talos" });
  expect(parseCommand(["folders", "remove", "talos"])).toEqual({ name: "folders-remove", folderName: "talos" });
  expect(parseCommand(["folders", "rename", "talos", "main"])).toEqual({ name: "folders-rename", folderName: "talos", newName: "main" });
});

test("session commands", () => {
  expect(parseCommand(["sessions"])).toEqual({ name: "sessions-list" });
  expect(parseCommand(["sessions", "fix-login", "attach"])).toEqual({ name: "sessions-attach", sessionName: "fix-login" });
  expect(parseCommand(["sessions", "fix-login", "stop"])).toEqual({ name: "sessions-stop", sessionName: "fix-login" });
  expect(parseCommand(["runner", "stop"])).toEqual({ name: "runner-stop" });
});

test("service commands", () => {
  expect(parseCommand(["install"])).toEqual({ name: "install" });
  expect(parseCommand(["uninstall"])).toEqual({ name: "uninstall" });
  expect(parseCommand(["update"])).toEqual({ name: "update" });
});

test.each([
  [["install", "now"]],
  [["update", "talos"]],
  [["sessions", "fix-login"]],
  [["sessions", "fix-login", "attach", "now"]],
  [["runner"]],
  [["runner", "start"]],
  [["folders", "add"]],
  [["folders", "remove"]],
  [["folders", "rename", "x"]],
  [["folders", "add", "a", "b"]],
  [["folders", "rename", "talos"]],
  [["folders", "remove", "a", "b"]],
  [["folders", "rename", "a", "b", "c"]],
  [["machines", "work-mac", "folders"]],
  [["help", "me"]],
  [["--help"]],
])("%p isn't a command", (args) => {
  expect(parseCommand(args)).toEqual({ name: "unknown", typed: args.join(" ") });
});

test("help lists every command", () => {
  ["  talos  ", "  talos help", "  talos folders  ", "talos folders add <path>", "talos folders remove <folder>", "talos sessions <session> attach", "talos runner stop"].forEach((line) =>
    expect(HELP_TEXT).toContain(line),
  );
});

test.each([
  ["~/code/talos", "/home/joe/code/talos", "/work/here", "/home/joe"],
  ["~", "/home/joe", "/work/here", "/home/joe"],
  [".", "/work/here", "/work/here", "/home/joe"],
  ["../other", "/work/other", "/work/here", "/home/joe"],
  ["/abs/path/", "/abs/path", "/work/here", "/home/joe"],
  ["~not-home", "/work/here/~not-home", "/work/here", "/home/joe"],
])("resolveFolderPath(%p) is %p", (typedPath, expected, currentFolder, homeFolder) => {
  expect(resolveFolderPath(typedPath, currentFolder, homeFolder)).toBe(expected);
});

test.each([
  [["folders"], true, false],
  [["folders", "add", "~/x"], true, false],
  [["sessions"], false, true],
  [["sessions", "fix", "stop"], false, true],
  [["runner", "stop"], false, true],
  [[], false, false],
  [["help"], false, false],
])("%p: a folder command %p, a session command %p", (args, isFolder, isSession) => {
  const command = parseCommand(args);
  expect([isFolderCommand(command), isSessionCommand(command)]).toEqual([isFolder, isSession]);
});

// Where the disk treats two spellings as one folder (macOS: case, and the two
// ways to write an accent), they're one real path; where it doesn't (Linux),
// the other spelling is no folder at all.
test("one folder typed two ways is one real path where the disk says they're one; a file isn't a folder", async () => {
  const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const folder = mkdtempSync(join(tmpdir(), "talos-folders-"));
  try {
    mkdirSync(join(folder, "Proj"));
    mkdirSync(join(folder, "caf\u00e9"));
    writeFileSync(join(folder, "file"), "");
    const sameAs = async (typed: string, real: string) =>
      expect(await realFolderPath(join(folder, typed))).toBe(existsSync(join(folder, typed)) ? await realFolderPath(join(folder, real)) : null);
    await sameAs("proj", "Proj");
    await sameAs("cafe\u0301", "caf\u00e9");
    expect(await realFolderPath(join(folder, "file"))).toBeNull();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
