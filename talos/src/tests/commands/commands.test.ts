import { expect, test } from "bun:test";
import { HELP_TEXT, isFolderCommand, isSessionCommand, parseCommand } from "../../commands";
import { resolveFolderPath } from "../../folder-commands";

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

test.each([
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
