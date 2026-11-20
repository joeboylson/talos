import { describe, expect, test } from "bun:test";
import {
  capDroppedMarkers,
  readSessionStatus,
  mergeSessionEntries,
  readSentImages,
  readSessionEntries,
  readSessionDecision,
  readSessionEntry,
  readSessionList,
  openDecisionOf,
  statusOf,
  toDroppedMarker,
  type SessionEntry,
  type SessionSummary,
} from "../../sessions";
import { LIMITS } from "../../limits";

describe("readSessionList", () => {
  test("keeps a good list, dropping anything extra", () => {
    expect(readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", extra: 1 }])).toEqual([
      { sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [] },
    ]);
  });

  test("rejects what isn't a list", () => {
    expect(readSessionList(null)).toBeNull();
  });

  test.each([
    [{ sessionName: "fix", folderName: "talos", state: "asleep" }],
    [{ sessionName: 1, folderName: "talos", state: "idle" }],
  ])("leaves out a bad session, keeping the rest %#", (bad) => {
    const good = { sessionName: "ok", folderName: "talos", state: "idle", asks: {}, openOutputs: [] };
    expect(readSessionList([bad, good]) as unknown).toEqual([good]);
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

  const withAsk = (ask: unknown): SessionSummary => readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", asks: { status: ask } }])![0]!;
  test("statusOf reads the status ask: pending while asking, then the answer", () => {
    expect(statusOf(withAsk({ state: "asking", atMs: 3 }))).toEqual({ state: "pending", note: "", atMs: 3 });
    expect(statusOf(withAsk({ state: "no-response", atMs: 4 }))).toEqual({ state: "no-response", note: "", atMs: 4 });
    expect(statusOf(withAsk({ state: "answered", atMs: 5, latest: { state: "working", note: "running the tests" } }))).toEqual(ok);
  });
  test("statusOf shows nothing for no ask, or an answer that isn't a status", () => {
    expect(statusOf(withAsk(undefined))).toBeNull();
    expect(statusOf(withAsk({ state: "answered", atMs: 5, latest: { state: "bad" } }))).toBeNull();
    expect(statusOf(withAsk({ state: "maybe", atMs: 5 }))).toBeNull();
  });
});

describe("readSessionDecision / list decision", () => {
  const ok = { id: "6f1c0b9e-3d2a-4b5c-8e7f-9a0b1c2d3e4f", question: "Which database?", choices: ["Postgres", "SQLite"], atMs: 5 };
  test("reads a decision", () => {
    expect(readSessionDecision(ok)).toEqual(ok);
  });
  test.each([
    ["one choice", { ...ok, choices: ["Postgres"] }],
    ["five choices", { ...ok, choices: ["a", "b", "c", "d", "e"] }],
    ["an empty choice", { ...ok, choices: ["Postgres", ""] }],
    ["a choice too long", { ...ok, choices: ["Postgres", "x".repeat(LIMITS.maxDecisionChoiceLength + 1)] }],
    ["an empty question", { ...ok, question: "" }],
    ["a question too long", { ...ok, question: "x".repeat(LIMITS.maxDecisionQuestionLength + 1) }],
    ["no time", { id: ok.id, question: ok.question, choices: ok.choices }],
    ["no id", { question: ok.question, choices: ok.choices, atMs: 5 }],
  ])("turns down %s", (_name, value) => {
    expect(readSessionDecision(value)).toBeNull();
  });
  const withOutputs = (openOutputs: unknown): SessionSummary =>
    readSessionList([{ sessionName: "fix", folderName: "talos", state: "needs-you", openOutputs }])![0]!;
  test("openDecisionOf reads the first open decision, with its id", () => {
    const { id, atMs, ...fields } = ok;
    expect(openDecisionOf(withOutputs([{ id: "s1", kind: "note", fields: {}, atMs: 1 }, { id, kind: "decision", fields, atMs }]))).toEqual(ok);
  });
  test("openDecisionOf shows nothing for a decision that isn't one, and a bad output is left out", () => {
    expect(openDecisionOf(withOutputs([{ id: "d1", kind: "decision", fields: { question: "?" }, atMs: 1 }]))).toBeNull();
    expect(withOutputs([{ id: "d1", kind: "decision", fields: "nope", atMs: 1 }]).openOutputs).toEqual([]);
    expect(withOutputs([{ id: "d1", kind: "decision", fields: { big: "x".repeat(LIMITS.maxOutputFieldsBytes) }, atMs: 1 }]).openOutputs).toEqual([]);
  });
});

describe("readSessionEntries", () => {
  test("keeps each kind of entry, dropping anything extra", () => {
    const entries = [
      { kind: "prompt", position: 0, entryId: "a", text: "hi", imageCount: 1, extra: 1 },
      { kind: "text", position: 0, entryId: "b", text: "hello" },
      { kind: "tool", position: 0, entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
      { kind: "output", position: 0, entryId: "d", outputKind: "decision", fields: { question: "?" } },
      { kind: "dropped", position: 0, entryId: "e", droppedKind: "text", reason: "failed its check" },
    ];
    expect(readSessionEntries(entries)).toEqual([
      { kind: "prompt", position: 0, entryId: "a", text: "hi", imageCount: 1 },
      { kind: "text", position: 0, entryId: "b", text: "hello" },
      { kind: "tool", position: 0, entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
      { kind: "output", position: 0, entryId: "d", outputKind: "decision", fields: { question: "?" } },
      { kind: "dropped", position: 0, entryId: "e", droppedKind: "text", reason: "failed its check" },
    ]);
  });

  test.each([
    [null],
    [Array.from({ length: LIMITS.maxEntriesKept + 1 }, (_, index) => ({ kind: "text", position: 0, entryId: `${index}`, text: "" }))],
  ])("rejects what isn't a list of entries %#", (value) => {
    expect(readSessionEntries(value)).toBeNull();
  });

  test.each([
    [{ kind: "text", position: 0, entryId: "a", text: 2 }, "text"],
    [{ kind: "text", position: 0, entryId: "a", text: "x".repeat(LIMITS.maxEntryTextLength + 1) }, "text"],
    [{ kind: "prompt", position: 0, entryId: "a", text: "hi", imageCount: -1 }, "prompt"],
    [{ kind: "tool", position: 0, entryId: "a", toolName: "Bash", summary: "", outcome: "maybe" }, "tool"],
    [{ kind: "other", entryId: "a" }, "other"],
  ])("puts a dropped marker in place of a bad entry, keeping the rest %#", (bad, droppedKind) => {
    const good = { kind: "text", position: 0, entryId: "b", text: "hi" };
    expect(readSessionEntries([bad, good]) as unknown).toEqual([{ kind: "dropped", position: 0, entryId: "a", droppedKind, reason: "failed its check" }, good]);
  });

  test("a bad entry with no readable id gets the same marker id each time it's sent", () => {
    const bad = { kind: "text", position: 0, entryId: 5, text: "hi" };
    const first = readSessionEntries([bad])?.[0];
    expect(first?.entryId).toMatch(/^dropped:/);
    expect(readSessionEntries([bad])?.[0]).toEqual(first);
  });

  test("markers are capped per batch and per session, so they can't push out real entries", () => {
    const bad = Array.from({ length: LIMITS.maxDroppedPerBatch + 5 }, (_, index) => ({ kind: "text", position: 0, entryId: `bad${index}`, text: 1 }));
    expect(readSessionEntries(bad)?.length).toBe(LIMITS.maxDroppedPerBatch);
    const markers = Array.from({ length: LIMITS.maxDroppedKept + 5 }, (_, index) => ({ kind: "dropped" as const, position: 0, entryId: `m${index}`, droppedKind: "text", reason: "x" }));
    const good = { kind: "text" as const, position: 0, entryId: "g", text: "hi" };
    const merged = mergeSessionEntries([good], markers, LIMITS.maxEntriesKept);
    expect(merged.filter((entry) => entry.kind === "dropped").length).toBe(LIMITS.maxDroppedKept);
    expect(merged[0]).toEqual(good);
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
    [[{ mediaType: "image/png", dataBase64: "x".repeat(LIMITS.maxImageBase64Length + 1) }]],
    [Array.from({ length: LIMITS.maxImagesPerMessage + 1 }, () => ({ mediaType: "image/png", dataBase64: "AAAA" }))],
  ])("rejects %#", (value) => {
    expect(readSentImages(value)).toBeNull();
  });
});

describe("mergeSessionEntries", () => {
  const running = { kind: "tool", position: 0, entryId: "t", toolName: "Bash", summary: "ls", outcome: "running" } as const;
  const text = { kind: "text", position: 0, entryId: "x", text: "hi" } as const;

  test("keeps the newest entries within the kept text budget, dropping the oldest", () => {
    const big = (entryId: string) => ({ kind: "text" as const, position: 0, entryId, text: "x".repeat(LIMITS.maxEntryTextLength) });
    const count = LIMITS.maxKeptEntryTextLength / LIMITS.maxEntryTextLength + 3;
    const entries = Array.from({ length: count }, (_unused, i) => big(`e${i}`));
    const kept = mergeSessionEntries([], entries, LIMITS.maxEntriesKept);
    expect(kept.length).toBe(LIMITS.maxKeptEntryTextLength / LIMITS.maxEntryTextLength);
    expect(kept.at(-1)?.entryId).toBe(`e${count - 1}`);
    expect(kept[0]?.entryId).toBe("e3");
  });

  // talos's reconnect resend relies on this to send only what changed.
  test("an entry that didn't change keeps the same object", () => {
    const [kept] = mergeSessionEntries([text, running], [{ ...running, outcome: "done" }], 10);
    expect(kept).toBe(text);
  });

  test("a tool that ends replaces its running copy in place", () => {
    const merged = mergeSessionEntries([running, text], [{ ...running, outcome: "done" }], 10);
    expect(merged).toEqual([{ ...running, outcome: "done" }, text]);
  });

  test("new entries go on the end, and old ones fall off past the limit", () => {
    const merged = mergeSessionEntries([running, text], [{ kind: "text", position: 0, entryId: "y", text: "more" }], 2);
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

const textOf = (entryId: string, length = 0): SessionEntry => ({ kind: "text", position: 0, entryId, text: "x".repeat(length) });
const markerOf = (entryId: string): SessionEntry => ({ kind: "dropped", position: 0, entryId, droppedKind: "text", reason: "x" });
const bigEntries = (count: number) => Array.from({ length: count }, (_unused, index) => textOf(`e${index}`, LIMITS.maxEntryTextLength));
const fieldsOfBytes = (byteCount: number) => ({ a: "x".repeat(byteCount - JSON.stringify({ a: "" }).length) });

describe("limits: exactly at the limit is kept, one past is turned down", () => {
  test("entry text, choices, entries, images and output fields at the limit are kept", () => {
    expect(readSessionEntry(textOf("a", LIMITS.maxEntryTextLength))).not.toBeNull();
    const choices = Array.from({ length: LIMITS.maxDecisionChoices }, (_unused, index) => `c${index}`);
    expect(readSessionDecision({ id: "d1", question: "?", choices, atMs: 1 })).not.toBeNull();
    expect(readSessionEntries(Array.from({ length: LIMITS.maxEntriesKept }, (_unused, index) => textOf(`${index}`)))).not.toBeNull();
    expect(readSentImages(Array.from({ length: LIMITS.maxImagesPerMessage }, () => ({ mediaType: "image/png", dataBase64: "AAAA" })))).not.toBeNull();
    expect(readSessionEntry({ kind: "output", position: 0, entryId: "o", outputKind: "note", fields: fieldsOfBytes(LIMITS.maxOutputFieldsBytes) })).not.toBeNull();
  });

  test("a session list holds at most maxSessions", () => {
    const sessionsOf = (count: number) => Array.from({ length: count }, (_unused, index) => ({ sessionName: `s${index}`, folderName: "talos", state: "idle" }));
    expect(readSessionList(sessionsOf(LIMITS.maxSessions))?.length).toBe(LIMITS.maxSessions);
    expect(readSessionList(sessionsOf(LIMITS.maxSessions + 1))).toBeNull();
  });

  test("output fields are measured in bytes, not characters", () => {
    const wideFields = { note: "é".repeat(LIMITS.maxOutputFieldsBytes / 2) };
    expect(readSessionEntry({ kind: "output", position: 0, entryId: "o", outputKind: "note", fields: wideFields })).toBeNull();
  });
});

describe("bad parts of a session are left out", () => {
  const sessionWith = (extra: object): SessionSummary => readSessionList([{ sessionName: "fix", folderName: "talos", state: "idle", ...extra }])![0]!;

  test("a decision with an empty id isn't one", () => {
    expect(readSessionDecision({ id: "", question: "?", choices: ["a", "b"], atMs: 1 })).toBeNull();
  });

  test("null fields aren't fields", () => {
    expect(readSessionEntry({ kind: "output", position: 0, entryId: "o", outputKind: "note", fields: null })).toBeNull();
    expect(sessionWith({ asks: { status: { state: "answered", atMs: 1, latest: null } } }).asks).toEqual({ status: { state: "answered", atMs: 1 } });
  });

  test("an ask with no time, or under a name too long, is left out", () => {
    expect(sessionWith({ asks: { status: { state: "asking" } } }).asks).toEqual({});
    expect(sessionWith({ asks: { ["k".repeat(LIMITS.maxNameTextLength + 1)]: { state: "asking", atMs: 1 } } }).asks).toEqual({});
  });

  test("open outputs are capped, and a bad one is left out", () => {
    const outputOf = (index: number) => ({ id: `o${index}`, kind: "note", fields: {}, atMs: 1 });
    const manyOutputs = Array.from({ length: LIMITS.maxOpenOutputs + 1 }, (_unused, index) => outputOf(index));
    expect(sessionWith({ openOutputs: manyOutputs }).openOutputs.length).toBe(LIMITS.maxOpenOutputs);
    const badOutputs = [{ ...outputOf(1), id: 5 }, { ...outputOf(2), kind: "k".repeat(LIMITS.maxNameTextLength + 1) }, { id: "o3", kind: "note", fields: {} }];
    expect(sessionWith({ openOutputs: badOutputs }).openOutputs).toEqual([]);
  });
});

describe("readSessionEntry checks every field of every kind", () => {
  test("a prompt with no images is kept", () => {
    expect(readSessionEntry({ kind: "prompt", position: 0, entryId: "a", text: "hi", imageCount: 0 })).not.toBeNull();
  });

  test.each([
    ["a tool with a bad name", { kind: "tool", position: 0, entryId: "a", toolName: 5, summary: "ls", outcome: "done" }],
    ["an output with a bad kind", { kind: "output", position: 0, entryId: "a", outputKind: 5, fields: {} }],
    ["a marker with a bad reason", { kind: "dropped", position: 0, entryId: "a", droppedKind: "text", reason: 5 }],
    ["a marker with a bad kind", { kind: "dropped", position: 0, entryId: "a", droppedKind: 5, reason: "x" }],
    ["an unknown kind shaped like a marker", { kind: "other", entryId: "a", droppedKind: "x", reason: "y" }],
  ])("turns down %s", (_name, item) => {
    expect(readSessionEntry(item)).toBeNull();
  });
});

describe("dropped markers", () => {
  test("different bad items with no readable id get different marker ids", () => {
    const markers = readSessionEntries([{ kind: "text", position: 0, entryId: 5, text: "a" }, { kind: "text", position: 0, entryId: 6, text: "b" }])!;
    expect(markers[0]?.entryId).not.toBe(markers[1]?.entryId);
  });

  test("a marker keeps only an id that is readable, names an unknown kind, and cuts its reason", () => {
    expect(toDroppedMarker({ entryId: "" }, "r").entryId).toMatch(/^dropped:/);
    expect(toDroppedMarker({ entryId: "x".repeat(LIMITS.maxIdTextLength + 1) }, "r").entryId).toMatch(/^dropped:/);
    expect(toDroppedMarker({ entryId: "x".repeat(LIMITS.maxIdTextLength) }, "r").entryId).toBe("x".repeat(LIMITS.maxIdTextLength));
    expect(toDroppedMarker({ kind: 5 }, "r")).toMatchObject({ droppedKind: "unknown" });
    expect(toDroppedMarker({}, "r".repeat(LIMITS.maxNameTextLength + 50))).toMatchObject({ reason: "r".repeat(LIMITS.maxNameTextLength) });
  });

  test("the cap counts markers, not other entries", () => {
    const entries = [markerOf("m"), ...Array.from({ length: 15 }, (_unused, index) => textOf(`g${index}`))];
    expect(capDroppedMarkers(entries, 10)).toEqual(entries);
  });

  test("the cap counts each marker, even many copies of one bad item", () => {
    expect(readSessionEntries(Array.from({ length: LIMITS.maxEntriesKept }, () => ({})))?.length).toBe(LIMITS.maxDroppedPerBatch);
  });

  test("a cap of 0 keeps no markers", () => {
    expect(capDroppedMarkers([markerOf("m"), textOf("g")], 0)).toEqual([textOf("g")]);
  });
});

describe("mergeSessionEntries edge cases", () => {
  test("a null new entry is skipped", () => {
    expect(mergeSessionEntries([textOf("a")], [null as unknown as SessionEntry], 10)).toEqual([textOf("a")]);
  });

  test("the text budget counts a tool's name and summary, and an output's fields", () => {
    const tool: SessionEntry = { kind: "tool", position: 0, entryId: "t", toolName: "B", summary: "x".repeat(LIMITS.maxToolSummaryLength), outcome: "done" };
    const output: SessionEntry = { kind: "output", position: 0, entryId: "o", outputKind: "note", fields: { a: "x".repeat(100) } };
    const budgetCount = LIMITS.maxKeptEntryTextLength / LIMITS.maxEntryTextLength;
    expect(mergeSessionEntries([], [...bigEntries(budgetCount), tool], LIMITS.maxEntriesKept).map((entry) => entry.entryId)[0]).toBe("e1");
    expect(mergeSessionEntries([], [...bigEntries(budgetCount), output], LIMITS.maxEntriesKept).map((entry) => entry.entryId)[0]).toBe("e1");
  });

  const at = (entryId: string, position: number, length = 0): SessionEntry => ({ kind: "text", position, entryId, text: "x".repeat(length) });
  test("entries are kept in conversation order, whatever order they arrive in", () => {
    expect(mergeSessionEntries([at("b", 2)], [at("c", 3), at("a", 1)], 10).map(({ entryId }) => entryId)).toEqual(["a", "b", "c"]);
  });
  test("an old entry that arrives again after it was trimmed stays trimmed", () => {
    const conversation = Array.from({ length: 6 }, (_unused, index) => at(`e${index}`, index));
    const once = mergeSessionEntries([], conversation, 4);
    expect(once.map(({ entryId }) => entryId)).toEqual(["e2", "e3", "e4", "e5"]);
    expect(mergeSessionEntries(once, conversation, 4)).toEqual(once);
  });
  test("past the text budget too, the same entries twice change nothing", () => {
    const conversation = Array.from({ length: LIMITS.maxKeptEntryTextLength / LIMITS.maxEntryTextLength + 2 }, (_unused, index) => at(`e${index}`, index, LIMITS.maxEntryTextLength));
    const once = mergeSessionEntries([], conversation, LIMITS.maxEntriesKept);
    expect(mergeSessionEntries(once, conversation, LIMITS.maxEntriesKept)).toEqual(once);
  });
  test.each([
    ["no position", { kind: "text", entryId: "a", text: "hi" }],
    ["a negative position", { kind: "text", position: -1, entryId: "a", text: "hi" }],
    ["a position that isn't whole", { kind: "text", position: 1.5, entryId: "a", text: "hi" }],
  ])("an entry with %s is turned down", (_name, item) => {
    expect(readSessionEntry(item)).toBeNull();
  });

  test("a new entry that arrives with a kept tool's end is kept too", () => {
    const running: SessionEntry = { kind: "tool", position: 0, entryId: "t1", toolName: "Bash", summary: "ls", outcome: "running" };
    const merged = mergeSessionEntries([running], [textOf("x"), { ...running, outcome: "done" }], LIMITS.maxEntriesKept);
    expect(merged.map((entry) => entry.entryId)).toEqual(["t1", "x"]);
  });
});
