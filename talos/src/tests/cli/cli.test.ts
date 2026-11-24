import { describe, expect, test } from "bun:test";
import { closestCommand, cliError, describeError, EXIT_CODES, formatTable, parseArgs, usageError } from "../../cli";
import { KNOWN_COMMANDS } from "../../commands";

describe("parseArgs", () => {
  test("words keep their order, and flags may come anywhere", () => {
    expect(parseArgs(["sessions", "--json"])).toEqual({ words: ["sessions"], flags: { json: true, help: false, version: false, runner: false, add: false } });
    expect(parseArgs(["sessions", "start", ".", "--add"]).flags.add).toBe(true);
    expect(parseArgs(["--name", "homepage", "sessions", "start", "website"]).flags.name).toBe("homepage");
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["-V"]).flags.version).toBe(true);
  });
  test("a word that only starts with a dash is a word, and -- makes the rest words", () => {
    expect(parseArgs(["sessions", "web", "send", "-1 is the wrong sign"]).words).toEqual(["sessions", "web", "send", "-1 is the wrong sign"]);
    expect(parseArgs(["sessions", "web", "send", "--", "--force", "it"]).words).toEqual(["sessions", "web", "send", "--force", "it"]);
  });
  test("an unknown flag, or one missing its value, is a usage error", () => {
    const usageCodeOf = (argv: string[]) => {
      try {
        parseArgs(argv);
        return null;
      } catch (error) {
        return (error as { exitCode: number }).exitCode;
      }
    };
    expect(usageCodeOf(["--jsn"])).toBe(EXIT_CODES.usage);
    expect(usageCodeOf(["sessions", "start", "x", "--name"])).toBe(EXIT_CODES.usage);
    expect(usageCodeOf(["--owner", "--json"])).toBe(EXIT_CODES.usage);
  });
});

describe("describeError", () => {
  test("an error the person can fix is one line and the command that fixes it", () => {
    expect(describeError(cliError("this machine has no folder called x", "talos folders"), false)).toEqual({
      text: "talos: this machine has no folder called x\n  run: talos folders",
      exitCode: EXIT_CODES.failed,
    });
    expect(describeError(usageError("there's no --jsn option"), false).exitCode).toBe(EXIT_CODES.usage);
  });
  test("a bug is one line too; its stack only with TALOS_DEBUG", () => {
    const bug = new Error("talos: something broke");
    expect(describeError(bug, false).text).toBe("talos: something broke");
    expect(describeError(bug, true).text).toContain("at ");
  });
});

test("a table has a header and aligned columns in a terminal, and is tab-separated when piped", () => {
  const rows = [["fix-login", "talos", "ready"], ["homepage", "website", "working"]];
  expect(formatTable(["session", "folder", "state"], rows, true)).toBe(
    ["SESSION    FOLDER   STATE", "fix-login  talos    ready", "homepage   website  working"].join("\n"),
  );
  expect(formatTable(["session", "folder", "state"], rows, false)).toBe("fix-login\ttalos\tready\nhomepage\twebsite\tworking");
});

test("a mistyped command gets the closest real one; nonsense gets none", () => {
  expect(closestCommand("sesions", KNOWN_COMMANDS)).toBe("sessions");
  expect(closestCommand("service strat", KNOWN_COMMANDS)).toBe("service start");
  expect(closestCommand("statsu", KNOWN_COMMANDS)).toBe("status");
  expect(closestCommand("make me a sandwich", KNOWN_COMMANDS)).toBeNull();
  expect(closestCommand("bogus", KNOWN_COMMANDS)).toBeNull();
});
