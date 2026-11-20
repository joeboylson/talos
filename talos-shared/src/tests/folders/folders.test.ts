import { describe, expect, test } from "bun:test";
import { readFolderList } from "../../folders";
import { LIMITS } from "../../limits";

describe("readFolderList", () => {
  test("keeps a good list, dropping anything extra", () => {
    expect(readFolderList([{ folderName: "talos", path: "/x", extra: 1 }])).toEqual([{ folderName: "talos", path: "/x" }]);
    expect(readFolderList([])).toEqual([]);
  });

  test.each([[null], ["folders"], [[{ folderName: "x" }]], [[{ folderName: 1, path: "/x" }]], [Array(201).fill({ folderName: "a", path: "/a" })]])(
    "rejects %#",
    (value) => {
      expect(readFolderList(value)).toBeNull();
    },
  );
});

test("a folder list holds up to maxFolders, with paths up to maxPathLength", () => {
  expect(readFolderList(Array(LIMITS.maxFolders).fill({ folderName: "a", path: "/a" }))?.length).toBe(LIMITS.maxFolders);
  expect(readFolderList([{ folderName: "a", path: "/".repeat(LIMITS.maxPathLength) }])).not.toBeNull();
  expect(readFolderList([{ folderName: "a", path: "/".repeat(LIMITS.maxPathLength + 1) }])).toBeNull();
});
