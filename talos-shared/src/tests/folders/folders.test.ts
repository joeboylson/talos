import { describe, expect, test } from "bun:test";
import { readFolderList } from "../../folders";

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

