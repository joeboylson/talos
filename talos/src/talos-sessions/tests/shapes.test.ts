import { describe, expect, test } from "bun:test";
import { SESSION_LIMITS } from "../limits";
import {
  capDroppedMarkers,
  mergeSessionEntries,
  readSentImages,
  readSessionEntries,
  readSessionEntry,
  readSessionList,
  toDroppedMarker,
  type SessionEntry,
} from "../shapes";

const session = (extra: object = {}) => ({ sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [], ...extra });
const text = (entryId: string, body = "hi"): SessionEntry => ({ kind: "text", position: 0, entryId, text: body });
const marker = (entryId: string): SessionEntry => ({ kind: "dropped", position: 0, entryId, droppedKind: "text", reason: "bad" });

describe("readSessionList", () => {
  test("a bad session is left out and the rest kept", () => {
    expect(readSessionList([session(), session({ sessionName: "../x" }), session({ state: "asleep" })]) as unknown).toEqual([session()]);
  });
  test("a list over the session cap is turned down", () => {
    expect(readSessionList(Array.from({ length: SESSION_LIMITS.maxSessions + 1 }, () => session()))).toBeNull();
    expect(readSessionList("nope")).toBeNull();
  });
  test("a bad ask is left out, and latest is kept only when it's fields", () => {
    const asks = { status: { state: "answered", atMs: 2, latest: { note: "ok" } }, poll: { state: "asking", atMs: 1, latest: "x" }, tally: { state: "maybe", atMs: 1 }, junk: 5 };
    expect(readSessionList([session({ asks })])?.[0].asks).toEqual({ status: { state: "answered", atMs: 2, latest: { note: "ok" } }, poll: { state: "asking", atMs: 1 } });
  });
  test("open outputs are capped, and a bad one is left out", () => {
    const output = (id: string) => ({ id, kind: "decision", fields: {}, atMs: 1 });
    const openOutputs = [{ id: 5 }, ...Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 5 }, (_unused, index) => output(`o${index}`))];
    const read = readSessionList([session({ openOutputs })])?.[0].openOutputs ?? [];
    expect(read.length).toBe(SESSION_LIMITS.maxOpenOutputs - 1);
    expect(read[0]).toEqual(output("o0"));
  });
});

describe("readSentImages", () => {
  const image = { mediaType: "image/png", dataBase64: "AAAA" };
  test("no images is an empty list", () => {
    expect(readSentImages(undefined)).toEqual([]);
  });
  test("good images are kept, with only their fields", () => {
    expect(readSentImages([{ ...image, extra: 1 }]) as unknown).toEqual([image]);
  });
  test.each([
    ["too many", Array.from({ length: SESSION_LIMITS.maxImagesPerMessage + 1 }, () => image)],
    ["a bad media type", [{ ...image, mediaType: "image/svg+xml" }]],
    ["data too big", [{ ...image, dataBase64: "A".repeat(SESSION_LIMITS.maxImageBase64Length + 1) }]],
    ["not a list", "x"],
  ])("%s is turned down", (_name, value) => {
    expect(readSentImages(value)).toBeNull();
  });
});

describe("readSessionEntry and readSessionEntries", () => {
  test.each([
    ["a negative image count", { kind: "prompt", position: 0, entryId: "a", text: "x", imageCount: -1 }],
    ["a fractional image count", { kind: "prompt", position: 0, entryId: "a", text: "x", imageCount: 1.5 }],
    ["an output whose fields are a list", { kind: "output", position: 0, entryId: "a", outputKind: "decision", fields: [] }],
    ["an output whose fields are too big in bytes", { kind: "output", position: 0, entryId: "a", outputKind: "decision", fields: { text: "é".repeat(SESSION_LIMITS.maxOutputFieldsBytes / 2) } }],
    ["a tool with an unknown outcome", { kind: "tool", position: 0, entryId: "a", toolName: "Bash", summary: "", outcome: "maybe" }],
    ["a marker with a long reason", { kind: "dropped", position: 0, entryId: "a", droppedKind: "text", reason: "x".repeat(SESSION_LIMITS.maxNameTextLength + 1) }],
  ])("%s is turned down", (_name, item) => {
    expect(readSessionEntry(item)).toBeNull();
  });
  test("a good output is kept", () => {
    const output = { kind: "output", position: 0, entryId: "a", outputKind: "decision", fields: { question: "?" } };
    expect(readSessionEntry(output) as unknown).toEqual(output);
  });
  test("a list over the entry cap is turned down", () => {
    expect(readSessionEntries(Array.from({ length: SESSION_LIMITS.maxEntriesKept + 1 }, (_unused, index) => text(`e${index}`)))).toBeNull();
  });
  test("a flood of the same bad item keeps only the cap of markers", () => {
    const entries = readSessionEntries(Array.from({ length: 50 }, () => ({})));
    expect(entries?.length).toBe(SESSION_LIMITS.maxDroppedPerBatch);
  });
});

describe("toDroppedMarker", () => {
  test("a readable id is kept, so a good copy sent later replaces the marker", () => {
    expect(toDroppedMarker({ kind: "text", position: 0, entryId: "e1", text: 5 }, "bad")).toEqual({ kind: "dropped", position: 0, entryId: "e1", droppedKind: "text", reason: "bad" });
  });
  test("an unreadable id is hashed, the same way each time", () => {
    const first = toDroppedMarker({ kind: "text", position: 0, entryId: 5 }, "bad");
    expect(first.entryId).toMatch(/^dropped:[0-9a-f]+$/);
    expect(toDroppedMarker({ kind: "text", position: 0, entryId: 5 }, "bad").entryId).toBe(first.entryId);
    expect(toDroppedMarker({ kind: "text", position: 0, entryId: 6 }, "bad").entryId).not.toBe(first.entryId);
  });
  test("a long kind is unknown, and a long reason is cut", () => {
    const dropped = toDroppedMarker({ kind: "x".repeat(SESSION_LIMITS.maxNameTextLength + 1) }, "r".repeat(SESSION_LIMITS.maxNameTextLength + 5));
    expect(dropped).toMatchObject({ droppedKind: "unknown", reason: "r".repeat(SESSION_LIMITS.maxNameTextLength) });
  });
});

describe("capDroppedMarkers", () => {
  test("keeps the newest markers by position, and every other entry", () => {
    expect(capDroppedMarkers([marker("m1"), text("a"), marker("m1"), marker("m2"), text("b")], 2)).toEqual([text("a"), marker("m1"), marker("m2"), text("b")]);
  });
  test("a cap of zero keeps no marker", () => {
    expect(capDroppedMarkers([marker("m1"), text("a")], 0)).toEqual([text("a")]);
  });
});

describe("mergeSessionEntries", () => {
  test("a newer copy replaces the older in place, and new ones go on the end", () => {
    expect(mergeSessionEntries([text("a"), text("b")], [text("a", "again"), text("c")], 10)).toEqual([text("a", "again"), text("b"), text("c")]);
  });
  test("past the cap, the newest are kept", () => {
    expect(mergeSessionEntries([text("a"), text("b")], [text("c")], 2)).toEqual([text("b"), text("c")]);
  });
  test("past the text budget, the newest that fit are kept", () => {
    const third = "x".repeat(SESSION_LIMITS.maxKeptEntryTextLength / 3);
    const merged = mergeSessionEntries([], [text("a", third), text("b", third), text("c", third), text("d", third)], 10);
    expect(merged.map(({ entryId }) => entryId)).toEqual(["b", "c", "d"]);
  });
  test("a new entry that arrives with a kept tool's end is kept too", () => {
    const running: SessionEntry = { kind: "tool", position: 0, entryId: "t1", toolName: "Bash", summary: "ls", outcome: "running" };
    const merged = mergeSessionEntries([running], [text("x", "new"), { ...running, outcome: "done" }], 10);
    expect(merged.map(({ entryId }) => entryId)).toEqual(["t1", "x"]);
  });
  test("markers are capped at what a session keeps", () => {
    const markers = Array.from({ length: SESSION_LIMITS.maxDroppedKept + 5 }, (_unused, index) => marker(`m${index}`));
    expect(mergeSessionEntries([], markers, SESSION_LIMITS.maxEntriesKept).length).toBe(SESSION_LIMITS.maxDroppedKept);
  });
});
