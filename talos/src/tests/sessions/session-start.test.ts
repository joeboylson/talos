import { expect, test } from "bun:test";
import { EXIT_CODES } from "../../cli";
import { planSessionStart } from "../../session-commands";

const folders = [{ folderName: "website", path: "/Users/joe/code/website" }];

test("a session is named after its folder, and made unique among those running", () => {
  expect(planSessionStart("website", undefined, folders, [])).toEqual({ folder: folders[0], sessionName: "website" });
  expect(planSessionStart("website", undefined, folders, ["website"]).sessionName).toBe("website-2");
  expect(planSessionStart("website", undefined, folders, ["website", "website-2"]).sessionName).toBe("website-3");
});

test("--name names it, written like an identifier", () => {
  expect(planSessionStart("website", "New Homepage", folders, []).sessionName).toBe("new-homepage");
});

test("a folder this machine doesn't allow is refused, with the command that lists the ones it does", () => {
  expect(() => planSessionStart("secret", undefined, folders, [])).toThrow("this machine has no folder called secret");
  try {
    planSessionStart("secret", undefined, folders, []);
  } catch (error) {
    expect(error).toMatchObject({ fix: "talos folders", exitCode: EXIT_CODES.failed });
  }
});
