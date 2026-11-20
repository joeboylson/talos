import { describe, expect, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { addFolder, removeFolder, renameFolder } from "../../folders";

const TALOS = { folderName: "talos", path: "/home/joe/code/talos" };

describe("addFolder", () => {
  test("names a new folder after itself", () => {
    expect(addFolder([], "/home/joe/My Project")).toEqual({
      folders: [{ folderName: "my-project", path: "/home/joe/My Project" }],
      folder: { folderName: "my-project", path: "/home/joe/My Project" },
    });
  });

  test("two folders with the same name get -2", () => {
    const result = addFolder([TALOS], "/home/joe/old/talos");
    expect("folder" in result && result.folder.folderName).toBe("talos-2");
  });

  test("the same path twice is refused", () => {
    expect(addFolder([TALOS], TALOS.path)).toEqual({ problem: "/home/joe/code/talos is already a folder here (talos)" });
  });

  test("the root folder still gets a name", () => {
    const result = addFolder([], "/");
    expect("folder" in result && result.folder.folderName).toBe("unnamed");
  });
});

describe("removeFolder", () => {
  test("removes by name", () => {
    expect(removeFolder([TALOS], "talos")).toEqual({ folders: [], folder: TALOS });
  });

  test("an unknown name is a problem", () => {
    expect(removeFolder([TALOS], "nope")).toEqual({ problem: "this machine has no folder called nope" });
  });
});

describe("renameFolder", () => {
  const WEB = { folderName: "web", path: "/home/joe/code/web" };

  test("changes the name, never the path", () => {
    expect(renameFolder([TALOS, WEB], "talos", "Main App")).toEqual({
      folders: [{ folderName: "main-app", path: TALOS.path }, WEB],
      folder: { folderName: "main-app", path: TALOS.path },
    });
  });

  test("a name another folder has gets -2", () => {
    const result = renameFolder([TALOS, WEB], "talos", "web");
    expect("folder" in result && result.folder.folderName).toBe("web-2");
  });

  test("an unknown folder is a problem", () => {
    expect(renameFolder([TALOS], "nope", "x")).toEqual({ problem: "this machine has no folder called nope" });
  });
});

describe("the folder cap", () => {
  const foldersOf = (count: number) => Array.from({ length: count }, (_unused, index) => ({ folderName: `f${index}`, path: `/f${index}` }));
  test("a machine can fill up to the cap, and no further", () => {
    expect("folder" in addFolder(foldersOf(LIMITS.maxFolders - 1), "/last")).toBe(true);
    expect(addFolder(foldersOf(LIMITS.maxFolders), "/more")).toEqual({ problem: `this machine already has ${LIMITS.maxFolders} folders` });
  });
});
