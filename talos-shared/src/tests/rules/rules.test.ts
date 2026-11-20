import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFolderList } from "../../folders";
import { isIdentifierName, pickUniqueName, toIdentifierName } from "../../identifiers";
import { LIMITS } from "../../limits";
import { readMachineToServer, readPageToServer, readServerToMachine } from "../../message-readers";
import { batchEntriesBySize } from "../../entry-batches";
import {
  ASK_STATES,
  IMAGE_MEDIA_TYPES,
  SESSION_STATES,
  TOOL_OUTCOMES,
  mergeSessionEntries,
  readSentImages,
  readSessionDecision,
  readSessionEntries,
  readSessionEntry,
  readSessionList,
  readSessionStatus,
  type SessionEntry,
} from "../../sessions";

// Every rule replays from a fixed seed, so it can't make the suite flaky.
const RUNS = { seed: 20261120, numRuns: 2000 };

// Odd values that a bad side could send in any field.
const WORDS = ["", "fix", "ok", "talos", "m1", "o1", "status", "decision", "../..", "Fix Login", "a b", "x".repeat(LIMITS.maxIdTextLength + 1)];
const { odd } = fc.letrec((tie) => ({
  odd: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -3, max: 6 }),
    fc.double({ noNaN: true }),
    fc.string({ maxLength: 8 }),
    fc.constantFrom(...WORDS),
    fc.array(tie("odd"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("type", "kind", "entryId", "text", "id", "state", "atMs"), tie("odd"), { maxKeys: 3 }),
  ),
}));
// Mostly a good value, sometimes an odd one, so readers get past their first checks.
const maybe = <T,>(good: fc.Arbitrary<T>) => fc.oneof({ arbitrary: good, weight: 4 }, { arbitrary: odd, weight: 1 });
const opt = { requiredKeys: [] as never[] };

const name = fc.constantFrom("fix", "ok", "talos", "work-mac");
const shortText = fc.string({ maxLength: 12 });
const atMs = fc.integer({ min: 0, max: 1e12 });
const fields = fc.dictionary(fc.constantFrom("question", "choices", "state", "note"), maybe(fc.oneof(shortText, fc.array(shortText, { maxLength: 5 }))), { maxKeys: 3 });

const entry = fc.oneof(
  fc.record({ kind: maybe(fc.constant("prompt")), entryId: maybe(name), text: maybe(shortText), imageCount: maybe(fc.nat(3)) }, opt),
  fc.record({ kind: maybe(fc.constant("text")), entryId: maybe(name), text: maybe(shortText) }, opt),
  fc.record({ kind: maybe(fc.constant("tool")), entryId: maybe(name), toolName: maybe(shortText), summary: maybe(shortText), outcome: maybe(fc.constantFrom(...TOOL_OUTCOMES)) }, opt),
  fc.record({ kind: maybe(fc.constant("output")), entryId: maybe(name), outputKind: maybe(name), fields: maybe(fields) }, opt),
  fc.record({ kind: maybe(fc.constant("dropped")), entryId: maybe(name), droppedKind: maybe(name), reason: maybe(shortText) }, opt),
);
const entries = maybe(fc.array(maybe(entry), { maxLength: 15 }));
const images = maybe(fc.array(maybe(fc.record({ mediaType: maybe(fc.constantFrom(...IMAGE_MEDIA_TYPES)), dataBase64: maybe(shortText) }, opt)), { maxLength: 5 }));
const ask = fc.record({ state: maybe(fc.constantFrom(...ASK_STATES)), atMs: maybe(atMs), latest: maybe(fields) }, opt);
const output = fc.record({ id: maybe(name), kind: maybe(fc.constantFrom("decision", "note")), fields: maybe(fields), atMs: maybe(atMs) }, opt);
const session = fc.record(
  {
    sessionName: maybe(name),
    folderName: maybe(name),
    state: maybe(fc.constantFrom(...SESSION_STATES)),
    asks: maybe(fc.dictionary(fc.constantFrom("status", "other"), maybe(ask), { maxKeys: 2 })),
    openOutputs: maybe(fc.array(maybe(output), { maxLength: 4 })),
  },
  opt,
);
const sessions = maybe(fc.array(maybe(session), { maxLength: 4 }));
const folders = maybe(fc.array(maybe(fc.record({ folderName: maybe(name), path: maybe(shortText) }, opt)), { maxLength: 4 }));

const TYPES = ["ping", "pong", "error", "folders", "sessions", "session-entries", "machine-name", "rename-folder", "start-session", "send-to-session", "stop-session", "ask-for-output", "answer-output", "other"];
const message = maybe(
  fc.record(
    {
      type: maybe(fc.constantFrom(...TYPES)),
      machineId: maybe(name),
      sessionName: maybe(name),
      folderName: maybe(name),
      machineName: maybe(name),
      newFolderName: maybe(shortText),
      id: maybe(name),
      kind: maybe(name),
      outputId: maybe(name),
      choice: maybe(fc.integer({ min: -1, max: 4 })),
      text: maybe(shortText),
      message: maybe(shortText),
      images,
      folders,
      sessions,
      entries,
    },
    opt,
  ),
);

// Reading what a reader gave back gives back the same thing.
const readers: [string, (value: unknown) => unknown, fc.Arbitrary<unknown>][] = [
  ["readPageToServer", readPageToServer, message],
  ["readServerToMachine", readServerToMachine, message],
  ["readMachineToServer", readMachineToServer, message],
  ["readFolderList", readFolderList, folders],
  ["readSessionList", readSessionList, sessions],
  ["readSessionEntries", readSessionEntries, entries],
  ["readSessionEntry", readSessionEntry, maybe(entry)],
  ["readSentImages", readSentImages, images],
  ["readSessionStatus", readSessionStatus, maybe(fc.record({ state: maybe(fc.constantFrom("working", "done", "pending")), note: maybe(shortText), atMs: maybe(atMs) }, opt))],
  ["readSessionDecision", readSessionDecision, maybe(fc.record({ id: maybe(name), question: maybe(shortText), choices: maybe(fc.array(shortText, { maxLength: 5 })), atMs: maybe(atMs) }, opt))],
];

describe.each(readers)("%s", (_name, read, input) => {
  test("never throws, whatever arrives", () => {
    fc.assert(fc.property(input, (value) => void read(value)), RUNS);
  });
  test("reading its own answer again gives the same answer", () => {
    fc.assert(
      fc.property(input, (value) => {
        const once = read(value);
        if (once !== null) expect(read(once)).toEqual(once);
      }),
      RUNS,
    );
  });
});

test("readSessionEntries puts a marker in place of each bad entry, losing only markers past the cap", () => {
  fc.assert(
    fc.property(fc.array(maybe(entry), { maxLength: 30 }), (items) => {
      const read = readSessionEntries(items)!;
      const goodCount = items.map(readSessionEntry).filter((item) => item !== null && item.kind !== "dropped").length;
      expect(read.filter((item) => item.kind !== "dropped").length).toBe(goodCount);
      const markerCount = items.length - goodCount;
      if (markerCount <= LIMITS.maxDroppedPerBatch) expect(read.length).toBe(items.length);
      else expect(read.length).toBeLessThan(items.length);
    }),
    RUNS,
  );
});

describe("identifier names", () => {
  test("toIdentifierName always gives a name isIdentifierName accepts, within the length limit", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: fc.constantFrom("a", "-", " ", ".", "'", "local", "Z") })), (text) => {
        const identifierName = toIdentifierName(text);
        expect(isIdentifierName(identifierName)).toBe(true);
        expect(identifierName.length).toBeLessThanOrEqual(LIMITS.maxIdentifierLength);
      }),
      RUNS,
    );
  });

  test("pickUniqueName gives a free identifier name", () => {
    const identifierName = fc.string({ unit: fc.constantFrom("a", "b", "-", "2"), maxLength: 45 }).map(toIdentifierName);
    fc.assert(
      fc.property(identifierName, fc.array(identifierName, { maxLength: 6 }), (wanted, taken) => {
        const picked = pickUniqueName(wanted, [wanted, ...taken]);
        expect(isIdentifierName(picked)).toBe(true);
        expect([wanted, ...taken]).not.toContain(picked);
      }),
      RUNS,
    );
  });
});

// Good entries with a few shared ids, so merges replace as well as add.
const goodEntry: fc.Arbitrary<SessionEntry> = fc.oneof(
  fc.record({ kind: fc.constant("text" as const), position: fc.constant(0), entryId: fc.constantFrom("a", "b", "c", "d", "e", "f"), text: fc.oneof(shortText, fc.constant("x".repeat(LIMITS.maxEntryTextLength))) }),
  fc.record({ kind: fc.constant("tool" as const), position: fc.constant(0), entryId: fc.constantFrom("a", "b", "t"), toolName: shortText, summary: shortText, outcome: fc.constantFrom(...TOOL_OUTCOMES) }),
  fc.record({ kind: fc.constant("dropped" as const), position: fc.constant(0), entryId: fc.string({ minLength: 1, maxLength: 3 }), droppedKind: name, reason: shortText }),
);
const textLength = (entry: SessionEntry): number =>
  entry.kind === "tool" ? entry.toolName.length + entry.summary.length : entry.kind === "dropped" ? entry.reason.length : entry.kind === "output" ? JSON.stringify(entry.fields).length : entry.text.length;

describe("mergeSessionEntries", () => {
  test("stays within the entry cap, the text budget and the marker cap, with no id twice", () => {
    fc.assert(
      fc.property(fc.array(goodEntry, { maxLength: 30 }), fc.array(goodEntry, { maxLength: 30 }), fc.integer({ min: 1, max: 40 }), (kept, added, maxKept) => {
        const merged = mergeSessionEntries(mergeSessionEntries([], kept, maxKept), added, maxKept);
        expect(merged.length).toBeLessThanOrEqual(maxKept);
        expect(merged.reduce((sum, item) => sum + textLength(item), 0)).toBeLessThanOrEqual(LIMITS.maxKeptEntryTextLength);
        expect(merged.filter((item) => item.kind === "dropped").length).toBeLessThanOrEqual(LIMITS.maxDroppedKept);
        expect(new Set(merged.map((item) => item.entryId)).size).toBe(merged.length);
      }),
      RUNS,
    );
  });

  // A conversation numbered in order; a batch is any stretch of it, sent any number of times.
  const conversation = fc.uniqueArray(goodEntry, { selector: (item) => item.entryId, maxLength: 30 }).map((items) => items.map((item, position) => ({ ...item, position })));
  test("the same entries arriving twice change nothing the second time", () => {
    fc.assert(
      fc.property(conversation, fc.nat(30), fc.nat(30), fc.integer({ min: 1, max: 40 }), (items, start, overlap, maxKept) => {
        const kept = mergeSessionEntries([], items.slice(0, start), maxKept);
        const once = mergeSessionEntries(kept, items.slice(Math.min(overlap, start)), maxKept);
        expect(mergeSessionEntries(once, items.slice(Math.min(overlap, start)), maxKept)).toEqual(once);
      }),
      RUNS,
    );
  });
  test("whatever order a conversation's entries arrive in, they're kept in conversation order", () => {
    fc.assert(
      fc.property(conversation.chain((items) => fc.shuffledSubarray(items, { minLength: items.length })), (shuffled) => {
        const positions = mergeSessionEntries([], shuffled, LIMITS.maxEntriesKept).map(({ position }) => position);
        expect(positions).toEqual([...positions].sort((first, second) => first - second));
      }),
      RUNS,
    );
  });

  test("a kept list sent again to a side that holds it changes nothing", () => {
    fc.assert(
      fc.property(fc.array(goodEntry, { maxLength: 30 }), fc.array(goodEntry, { maxLength: 30 }), fc.integer({ min: 1, max: 40 }), (kept, added, maxKept) => {
        const held = mergeSessionEntries(mergeSessionEntries([], kept, maxKept), added, maxKept);
        expect(mergeSessionEntries(held, held, maxKept)).toEqual(held);
      }),
      RUNS,
    );
  });
});

test("batchEntriesBySize keeps every entry in order, and each batch fits unless it holds one entry too big alone", () => {
  fc.assert(
    fc.property(fc.array(goodEntry, { maxLength: 60 }), fc.integer({ min: 1, max: 400 }), (items, maxBytes) => {
      const batches = batchEntriesBySize(items, maxBytes);
      expect(batches.flatMap((batch) => batch.entries)).toEqual(items);
      batches.forEach((batch) => {
        expect(batch.byteCount).toBe(batch.entries.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0));
        expect(batch.entries.length).toBeGreaterThan(0);
        expect(batch.entries.length).toBeLessThanOrEqual(LIMITS.maxEntriesKept);
        if (batch.entries.length > 1) expect(batch.byteCount).toBeLessThanOrEqual(maxBytes);
      });
    }),
    RUNS,
  );
});
