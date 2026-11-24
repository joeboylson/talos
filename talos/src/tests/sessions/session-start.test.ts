import { expect, test } from "bun:test";
import { EXIT_CODES } from "../../cli";
import { chooseStartFolder, sessionNameFor } from "../../session-commands";

const website = { folderName: "website", path: "/Users/joe/code/website" };
const folders = [website];

test("a start finds the folder by its name, or by its path", () => {
  expect(chooseStartFolder("website", folders, null)).toEqual({ folder: website });
  expect(chooseStartFolder(".", folders, "/Users/joe/code/website")).toEqual({ folder: website });
});

test("a folder on disk that isn't one of this machine's comes back to be added", () => {
  expect(chooseStartFolder(".", folders, "/Users/joe/code/api")).toEqual({ pathToAdd: "/Users/joe/code/api" });
});

test("a name that's neither a folder here nor a folder on disk is refused, with the command that lists the ones there are", () => {
  expect(() => chooseStartFolder("secret", folders, null)).toThrow("this machine has no folder called secret");
  try {
    chooseStartFolder("secret", folders, null);
  } catch (error) {
    expect(error).toMatchObject({ fix: "talos folders", exitCode: EXIT_CODES.failed });
  }
});

test("a session is named after its folder, and made unique among those running", () => {
  expect(sessionNameFor(website, undefined, [])).toBe("website");
  expect(sessionNameFor(website, undefined, ["website"])).toBe("website-2");
  expect(sessionNameFor(website, undefined, ["website", "website-2"])).toBe("website-3");
});

test("--name names it, written like an identifier", () => {
  expect(sessionNameFor(website, "New Homepage", [])).toBe("new-homepage");
});
