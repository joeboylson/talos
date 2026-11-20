import { describe, expect, test } from "bun:test";
import { LIMITS, isIdentifierName as sharedIsIdentifierName, readSessionEntries as sharedReadSessionEntries } from "talos-shared";
import { COPIED_LIMITS, isIdentifierName, readSessionEntries } from "../../talos-sessions";

// talos-sessions can't import talos-shared, so it keeps copies of what both
// check. These fail if a copy drifts from talos-shared's.
describe("talos-sessions' copies of talos-shared's rules", () => {
  test.each(Object.entries(COPIED_LIMITS))("%s matches", (name, value) => {
    expect(value).toBe(LIMITS[name as keyof typeof LIMITS]);
  });

  const names = ["fix-login", "a", "a1-b2", "x".repeat(40), "x".repeat(41), "", "Fix", "-a", "a-", "a--b", "a_b", "../x", "a.local", "unnamed", 7, null];
  test.each(names.map((name) => [name]))("the name rule agrees on %p", (name) => {
    expect(isIdentifierName(name)).toBe(sharedIsIdentifierName(name));
  });

  const entryLists = [
    [{ kind: "text", position: 0, entryId: "a", text: "hi" }, { kind: "prompt", position: 0, entryId: "b", text: "x", imageCount: 2 }],
    [{ kind: "tool", position: 0, entryId: "c", toolName: "Bash", summary: "ls", outcome: "done" }, { kind: "dropped", position: 0, entryId: "d", droppedKind: "text", reason: "x" }],
    [{ kind: "text", position: 0, entryId: 5, text: "hi" }, { kind: "text", position: 0, entryId: "e", text: "x".repeat(LIMITS.maxEntryTextLength + 1) }, { kind: "other" }],
    Array.from({ length: LIMITS.maxDroppedPerBatch + 3 }, (_, index) => ({ kind: "text", position: 0, entryId: `f${index}`, text: 1 })),
    Array.from({ length: LIMITS.maxDroppedPerBatch + 3 }, () => ({})),
    [{ kind: "output", position: 0, entryId: "g", outputKind: "decision", fields: { text: "é".repeat(LIMITS.maxOutputFieldsBytes / 2) } }],
    null,
  ];
  test.each(entryLists.map((entries) => [entries]))("the entry check agrees on %#", (entries) => {
    expect(readSessionEntries(entries) as unknown).toEqual(sharedReadSessionEntries(entries));
  });
});
