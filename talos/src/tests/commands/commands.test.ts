import { expect, test } from "bun:test";
import { HELP_TEXT, parseCommand } from "../../commands";

test("no command connects", () => {
  expect(parseCommand([])).toEqual({ name: "connect" });
});

test("help shows the list", () => {
  expect(parseCommand(["help"])).toEqual({ name: "help" });
});

test.each([[["machines"]], [["help", "me"]], [["connect"]], [["--help"]]])("%p isn't a command yet", (args) => {
  expect(parseCommand(args)).toEqual({ name: "unknown", typed: args.join(" ") });
});

test("help lists every command", () => {
  expect(HELP_TEXT).toContain("  talos  ");
  expect(HELP_TEXT).toContain("  talos help");
});
