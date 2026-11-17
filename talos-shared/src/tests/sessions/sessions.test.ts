import { describe, expect, test } from "bun:test";
import { readExchange, readSessionList } from "../../sessions";

describe("readSessionList", () => {
  test("keeps a good list, dropping anything extra", () => {
    expect(readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", extra: 1 }])).toEqual([
      { sessionName: "fix", folderName: "talos", state: "idle" },
    ]);
  });

  test.each([
    [null],
    [[{ sessionName: "fix", folderName: "talos", state: "asleep" }]],
    [[{ sessionName: 1, folderName: "talos", state: "idle" }]],
  ])("rejects %#", (value) => {
    expect(readSessionList(value)).toBeNull();
  });
});

describe("readExchange", () => {
  test("keeps a good exchange", () => {
    expect(readExchange({ prompt: "hi", reply: "hello", finishedAtMs: 1 })).toEqual({
      prompt: "hi",
      reply: "hello",
      finishedAtMs: 1,
    });
  });

  test.each([
    [null],
    [{ prompt: "hi", reply: 2, finishedAtMs: 1 }],
    [{ prompt: "x".repeat(100_001), reply: "", finishedAtMs: 1 }],
  ])("rejects %#", (value) => {
    expect(readExchange(value)).toBeNull();
  });
});
