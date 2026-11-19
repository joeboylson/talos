import { describe, expect, test } from "bun:test";
import {
  MAX_ENTRIES_KEPT,
  readSessionStatus,
  MAX_ENTRY_TEXT_LENGTH,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  mergeSessionEntries,
  readSentImages,
  readSessionEntries,
  readSessionList,
} from "../../sessions";

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

describe("readSessionStatus / list status", () => {
  const ok = { state: "working" as const, note: "running the tests", atMs: 5 };

  test("keeps a good status", () => {
    expect(readSessionStatus(ok)).toEqual(ok);
    expect(readSessionStatus({ state: "no-response", note: "", atMs: 9 })).toEqual({ state: "no-response", note: "", atMs: 9 });
  });

  test.each([
    [{ state: "nope", note: "x", atMs: 1 }],
    [{ state: "working", note: 5, atMs: 1 }],
    [{ state: "working", note: "x" }],
    [null],
    ["working"],
  ])("rejects a bad status %#", (value) => {
    expect(readSessionStatus(value)).toBeNull();
  });

  test("readSessionList keeps a valid status, drops a session with an invalid one", () => {
    expect(readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", status: ok }])).toEqual([
      { sessionName: "fix", folderName: "talos", state: "idle", status: ok },
    ]);
    expect(readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle" }])).toEqual([
      { sessionName: "fix", folderName: "talos", state: "idle" },
    ]);
    expect(readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", status: { state: "bad" } }])).toBeNull();
  });
});

describe("readSessionEntries", () => {
  test("keeps each kind of entry, dropping anything extra", () => {
    const entries = [
      { kind: "prompt", entryId: "a", text: "hi", imageCount: 1, extra: 1 },
      { kind: "text", entryId: "b", text: "hello" },
      { kind: "tool", entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
    ];
    expect(readSessionEntries(entries)).toEqual([
      { kind: "prompt", entryId: "a", text: "hi", imageCount: 1 },
      { kind: "text", entryId: "b", text: "hello" },
      { kind: "tool", entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
    ]);
  });

  test.each([
    [null],
    [[{ kind: "text", entryId: "a", text: 2 }]],
    [[{ kind: "text", entryId: "a", text: "x".repeat(MAX_ENTRY_TEXT_LENGTH + 1) }]],
    [[{ kind: "prompt", entryId: "a", text: "hi", imageCount: -1 }]],
    [[{ kind: "tool", entryId: "a", toolName: "Bash", summary: "", outcome: "maybe" }]],
    [[{ kind: "other", entryId: "a" }]],
    [Array.from({ length: MAX_ENTRIES_KEPT + 1 }, (_, index) => ({ kind: "text", entryId: `${index}`, text: "" }))],
  ])("rejects %#", (value) => {
    expect(readSessionEntries(value)).toBeNull();
  });
});

describe("readSentImages", () => {
  test("no images is an empty list", () => {
    expect(readSentImages(undefined)).toEqual([]);
  });

  test("keeps good images", () => {
    expect(readSentImages([{ mediaType: "image/png", dataBase64: "AAAA" }])).toEqual([
      { mediaType: "image/png", dataBase64: "AAAA" },
    ]);
  });

  test.each([
    [[{ mediaType: "text/html", dataBase64: "AAAA" }]],
    [[{ mediaType: "image/png", dataBase64: "x".repeat(MAX_IMAGE_BASE64_LENGTH + 1) }]],
    [Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mediaType: "image/png", dataBase64: "AAAA" }))],
  ])("rejects %#", (value) => {
    expect(readSentImages(value)).toBeNull();
  });
});

describe("mergeSessionEntries", () => {
  const running = { kind: "tool", entryId: "t", toolName: "Bash", summary: "ls", outcome: "running" } as const;
  const text = { kind: "text", entryId: "x", text: "hi" } as const;

  test("a tool that ends replaces its running copy in place", () => {
    const merged = mergeSessionEntries([running, text], [{ ...running, outcome: "done" }], 10);
    expect(merged).toEqual([{ ...running, outcome: "done" }, text]);
  });

  test("new entries go on the end, and old ones fall off past the limit", () => {
    const merged = mergeSessionEntries([running, text], [{ kind: "text", entryId: "y", text: "more" }], 2);
    expect(merged.map((entry) => entry.entryId)).toEqual(["x", "y"]);
  });

  test("entries sent again after a reconnect aren't doubled", () => {
    expect(mergeSessionEntries([running, text], [running, text], 10)).toEqual([running, text]);
  });

  test("an entry without a string id is skipped (defends the page's raw decode)", () => {
    const bad = { kind: "text", text: "no id" } as unknown as typeof text;
    expect(mergeSessionEntries([text], [bad], 10)).toEqual([text]);
  });
});
