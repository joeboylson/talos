import { describe, expect, test } from "bun:test";
import { batchEntriesBySize } from "../../entry-batches";
import { type SessionEntry } from "../../sessions";
import { LIMITS } from "../../limits";

const textEntry = (entryId: string, length: number): SessionEntry => ({ kind: "text", entryId, text: "x".repeat(length) });
const sizeOf = (entry: SessionEntry) => Buffer.byteLength(JSON.stringify(entry));

describe("batchEntriesBySize", () => {
  test("keeps small entries in one batch", () => {
    const entries = [textEntry("a", 10), textEntry("b", 10)];
    expect(batchEntriesBySize(entries, 1000).map((batch) => batch.entries)).toEqual([entries]);
  });

  test("starts a new batch before going over the limit, keeping order", () => {
    const entries = [textEntry("a", 100), textEntry("b", 100), textEntry("c", 100)];
    const limit = sizeOf(entries[0]) * 2;
    const batches = batchEntriesBySize(entries, limit);
    expect(batches.map((batch) => batch.entries.map((entry) => entry.entryId))).toEqual([["a", "b"], ["c"]]);
    expect(batches.every((batch) => batch.byteCount <= limit)).toBe(true);
  });

  test("counts bytes, not characters", () => {
    const entry: SessionEntry = { kind: "text", entryId: "a", text: "é".repeat(10) };
    expect(batchEntriesBySize([entry], 1000)[0].byteCount).toBe(sizeOf(entry));
  });

  test("gives an entry bigger than the limit a batch of its own", () => {
    const entries = [textEntry("a", 10), textEntry("big", 500), textEntry("c", 10)];
    expect(batchEntriesBySize(entries, 100).map((batch) => batch.entries.length)).toEqual([1, 1, 1]);
  });

  test("a reconnect's worst case fits the server's limit", () => {
    const entries = Array.from({ length: LIMITS.maxEntriesKept }, (_unused, i) => textEntry(`e${i}`, LIMITS.maxEntryTextLength));
    const limit = 4 * 1024 * 1024;
    expect(batchEntriesBySize(entries, limit).every((batch) => batch.byteCount <= limit)).toBe(true);
  });

  test("stays linear on a large read (would be seconds if quadratic)", () => {
    const entries = Array.from({ length: 50_000 }, (_unused, i) => textEntry(`e${i}`, 10));
    const startMs = Date.now();
    expect(batchEntriesBySize(entries, 4 * 1024 * 1024).length).toBe(100);
    expect(Date.now() - startMs).toBeLessThan(500);
  });

  test("holds at most LIMITS.maxEntriesKept entries per batch", () => {
    const entries = Array.from({ length: 1201 }, (_unused, i) => textEntry(`e${i}`, 1));
    expect(batchEntriesBySize(entries, 4 * 1024 * 1024).map((batch) => batch.entries.length)).toEqual([500, 500, 201]);
  });

  test("no entries, no batches", () => {
    expect(batchEntriesBySize([], 1000)).toEqual([]);
  });
});
