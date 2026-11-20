import { describe, expect, test } from "bun:test";
import {
  readSessionStatus,
  mergeSessionEntries,
  readSentImages,
  readSessionEntries,
  readSessionDecision,
  readSessionList,
  openDecisionOf,
  statusOf,
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
      { kind: "prompt", entryId: "a", text: "hi", imageCount: 1, extra: 1 },
      { kind: "text", entryId: "b", text: "hello" },
      { kind: "tool", entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
      { kind: "output", entryId: "d", outputKind: "decision", fields: { question: "?" } },
      { kind: "dropped", entryId: "e", droppedKind: "text", reason: "failed its check" },
    ];
    expect(readSessionEntries(entries)).toEqual([
      { kind: "prompt", entryId: "a", text: "hi", imageCount: 1 },
      { kind: "text", entryId: "b", text: "hello" },
      { kind: "tool", entryId: "c", toolName: "Bash", summary: "git status", outcome: "running" },
      { kind: "output", entryId: "d", outputKind: "decision", fields: { question: "?" } },
      { kind: "dropped", entryId: "e", droppedKind: "text", reason: "failed its check" },
    ]);
  });

  test.each([
    [null],
    [Array.from({ length: LIMITS.maxEntriesKept + 1 }, (_, index) => ({ kind: "text", entryId: `${index}`, text: "" }))],
  ])("rejects what isn't a list of entries %#", (value) => {
    expect(readSessionEntries(value)).toBeNull();
  });

  test.each([
    [{ kind: "text", entryId: "a", text: 2 }, "text"],
    [{ kind: "text", entryId: "a", text: "x".repeat(LIMITS.maxEntryTextLength + 1) }, "text"],
    [{ kind: "prompt", entryId: "a", text: "hi", imageCount: -1 }, "prompt"],
    [{ kind: "tool", entryId: "a", toolName: "Bash", summary: "", outcome: "maybe" }, "tool"],
    [{ kind: "other", entryId: "a" }, "other"],
  ])("puts a dropped marker in place of a bad entry, keeping the rest %#", (bad, droppedKind) => {
    const good = { kind: "text", entryId: "b", text: "hi" };
    expect(readSessionEntries([bad, good]) as unknown).toEqual([{ kind: "dropped", entryId: "a", droppedKind, reason: "failed its check" }, good]);
  });

  test("a bad entry with no readable id gets the same marker id each time it's sent", () => {
    const bad = { kind: "text", entryId: 5, text: "hi" };
    const first = readSessionEntries([bad])?.[0];
    expect(first?.entryId).toMatch(/^dropped:/);
    expect(readSessionEntries([bad])?.[0]).toEqual(first);
  });

  test("markers are capped per batch and per session, so they can't push out real entries", () => {
    const bad = Array.from({ length: LIMITS.maxDroppedPerBatch + 5 }, (_, index) => ({ kind: "text", entryId: `bad${index}`, text: 1 }));
    expect(readSessionEntries(bad)?.length).toBe(LIMITS.maxDroppedPerBatch);
    const markers = Array.from({ length: LIMITS.maxDroppedKept + 5 }, (_, index) => ({ kind: "dropped" as const, entryId: `m${index}`, droppedKind: "text", reason: "x" }));
    const good = { kind: "text" as const, entryId: "g", text: "hi" };
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
  const running = { kind: "tool", entryId: "t", toolName: "Bash", summary: "ls", outcome: "running" } as const;
  const text = { kind: "text", entryId: "x", text: "hi" } as const;

  test("keeps the newest entries within the kept text budget, dropping the oldest", () => {
    const big = (entryId: string) => ({ kind: "text" as const, entryId, text: "x".repeat(LIMITS.maxEntryTextLength) });
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
