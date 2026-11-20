// Rules that must always hold, checked against random inputs from a fixed
// seed, so a run is the same every time and can't make the suite flaky.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { cleanLine, hasCommandMarker } from "../clean";
import { mcpToolName, type Catalog, type OutputKind } from "../kinds";
import { NO_LANE, stepLane, type Lane, type LaneEvent } from "../lanes/lane";
import { NO_OUTPUTS, stepOutputs, type Outputs, type OutputsEvent, type PendingOutput } from "../lanes/outputs";
import { readAnswer } from "../lanes/held";
import { SESSION_LIMITS } from "../limits";
import { capDroppedMarkers, mergeSessionEntries, readSessionEntries, readSessionEntry, type SessionEntry } from "../shapes";

const SEED = 20261120;
const RUNS = { seed: SEED, numRuns: 2000 };

// Text built from the characters that clean.ts and the command check care about.
const TRICKY = [
  "a", "b", "Tabs", "1", " ", "  ", "\t", "\n", "\r", " ", " ", "　",
  "/", "!", "#", "@", "​", "‎", "‮", "⁦", "﻿", "\u{e0041}",
  "́", "̈", "ᅟ", "ㅤ", "\x1b", "\x1b[201~", "\x07", "\x7f", "\x9b",
];
const trickyText = fc.array(fc.constantFrom(...TRICKY), { maxLength: 12 }).map((parts) => parts.join(""));
const anyText = fc.oneof(trickyText, fc.string({ unit: "binary", maxLength: 20 }));

describe("cleanLine", () => {
  test("cleaning twice gives the same text as cleaning once", () => {
    fc.assert(fc.property(anyText, (text) => cleanLine(cleanLine(text)) === cleanLine(text)), RUNS);
  });
  test("a cleaned text has no line breaks, controls, format characters or edge spaces", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const cleaned = cleanLine(text);
        return !/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(cleaned) && cleaned === cleaned.trim();
      }),
      RUNS,
    );
  });
  test("cleaning again never shows a command marker the first clean hid", () => {
    fc.assert(fc.property(anyText, (text) => hasCommandMarker(cleanLine(cleanLine(text))) === hasCommandMarker(cleanLine(text))), RUNS);
  });
});

// Made-up kinds, like lane.test.ts's: poll is asked for; pick may be sent in a
// prose turn, waits for an answer, and its cleaned choices are typed when clicked.
const objectOrNull = (value: unknown) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const kindOf = (kind: string, extra: Partial<OutputKind>): OutputKind => ({
  kind,
  toolName: `send_${kind}`,
  description: kind,
  inputSchema: { type: "object" },
  readFields: objectOrNull,
  badInputReason: "bad",
  typedFields: {},
  waits: false,
  ...extra,
});
const readPick = (toolInput: unknown) => {
  const choices = objectOrNull(toolInput)?.choices;
  return Array.isArray(choices) && choices.every((choice) => typeof choice === "string") ? { choices: choices.map(cleanLine) } : null;
};
const POLL = kindOf("poll", { requestText: "Send a poll." });
const PICK = kindOf("pick", { readFields: readPick, typedFields: { choices: { allowCommands: false } }, choicesField: "choices", waits: true });
const CATALOG: Catalog = { kinds: [POLL, PICK], proseTurn: { output: "prose", optional: ["pick"] } };
const PICK_TOOL = mcpToolName(PICK.toolName);
const POLL_TOOL = mcpToolName(POLL.toolName);

describe("a choice typed into the session never holds a command", () => {
  test("whatever choices the session sends, the answer typed has no command marker", () => {
    const choices = fc.uniqueArray(anyText, { minLength: 2, maxLength: 4 });
    fc.assert(
      fc.property(choices, fc.nat(3), (picked, index) => {
        const event: LaneEvent = { type: "pre-tool-use", toolName: PICK_TOOL, toolInput: { choices: picked }, isSubagent: false, toolUseId: "tu", outputId: "out-1" };
        const step = stepLane(NO_LANE, event, 0, CATALOG);
        if (!step.sent) return true;
        const outputs: Outputs = { turn: 1, pending: [], open: [{ id: "out-1", kind: "pick", fields: step.sent.fields, atMs: 0, askedInTurn: 1 }] };
        const answer = readAnswer(outputs, [], CATALOG, "out-1", index, 0);
        if ("refusal" in answer) return true;
        const typedChoice = answer.text.slice("Answer to out-1: ".length);
        return !hasCommandMarker(typedChoice) && !hasCommandMarker(cleanLine(typedChoice));
      }),
      RUNS,
    );
  });
});

// Random lane events, with the clock moving forward by random steps.
const TOOLS = ["Bash", "Edit", "Task", "ToolSearch", PICK_TOOL, POLL_TOOL, "mcp__talos__other", "mcp__other__send_poll"];
const laneEvent: fc.Arbitrary<{ event: LaneEvent; advanceMs: number }> = fc.record({
  advanceMs: fc.oneof(fc.constant(0), fc.nat(5_000), fc.constant(SESSION_LIMITS.askTimeoutMs + 1), fc.constant(SESSION_LIMITS.queuedAskTimeoutMs + 1)),
  event: fc.oneof(
    fc.record({ type: fc.constant("ask" as const), kind: fc.constantFrom("poll", "pick", "nope") }),
    fc.record({ type: fc.constant("settled" as const), hasDraft: fc.boolean() }),
    fc.record({
      type: fc.constant("pre-tool-use" as const),
      toolName: fc.constantFrom(...TOOLS),
      toolInput: fc.constantFrom({}, { choices: ["Yes", "No"] }, { choices: ["/x"] }, null),
      isSubagent: fc.constant(false),
      toolUseId: fc.constant("tu"),
      outputId: fc.constant("out"),
    }),
    fc.record({
      type: fc.constant("went-through" as const),
      output: fc.constantFrom("poll", "pick").map((kind): PendingOutput => ({ id: "out", toolUseId: "tu", kind, fields: {}, atMs: 0, waits: kind === "pick" })),
    }),
    fc.constant({ type: "stop" as const }),
    fc.record({ type: fc.constant("person-typed" as const), isTurnChanging: fc.boolean() }),
    fc.constant({ type: "tick" as const }),
  ),
});
const isRunning = (lane: Lane) => lane.stage === "asking" || lane.stage === "answered";
const decisionOf = (reply: string): string => (reply ? (JSON.parse(reply).hookSpecificOutput?.permissionDecision ?? "") : "");

describe("the lane", () => {
  test("no event sequence lets another tool run in an asked-for turn before it ends", () => {
    fc.assert(
      fc.property(fc.array(laneEvent, { minLength: 10, maxLength: 60, size: "max" }), (events) => {
        let lane: Lane = NO_LANE;
        let nowMs = 0;
        for (const { event, advanceMs } of events) {
          nowMs += advanceMs;
          const before = lane;
          const step = stepLane(lane, event, nowMs, CATALOG);
          if (event.type === "pre-tool-use" && isRunning(before)) {
            const askedTool = mcpToolName(CATALOG.kinds.find(({ kind }) => kind === before.output)!.toolName);
            const mayRun = event.toolName === "ToolSearch" || event.toolName === askedTool;
            if (!mayRun && decisionOf(step.hookReply) !== "deny") return false;
          }
          // Only the settle, a turn-changing key or the long backstop ends a running turn.
          // A running turn ends only on a turn-changing key, the long backstop, or
          // (once answered) the settle. A Stop or the short timeout never ends it.
          if (isRunning(before) && step.lane.stage === "none") {
            const isLongBackstop = event.type === "tick" && nowMs - before.askedAtMs > SESSION_LIMITS.queuedAskTimeoutMs;
            const isTurnChangingKey = event.type === "person-typed" && event.isTurnChanging;
            const isAnsweredSettle = event.type === "settled" && before.stage === "answered";
            if (!isLongBackstop && !isTurnChangingKey && !isAnsweredSettle) return false;
          }
          lane = step.lane;
        }
        return true;
      }),
      RUNS,
    );
  });
});

// Random outputs events over a few ids, so calls, ids and turns collide.
const IDS = ["a", "b", "c"];
const outputsEvent: fc.Arbitrary<OutputsEvent> = fc.oneof(
  fc.record({
    type: fc.constant("sent" as const),
    output: fc.record({ id: fc.constantFrom(...IDS), toolUseId: fc.constantFrom(...IDS), waits: fc.boolean() }).map(
      ({ id, toolUseId, waits }): PendingOutput => ({ id, toolUseId: `tu-${toolUseId}`, kind: "pick", fields: {}, atMs: 0, waits }),
    ),
  }),
  fc.record({ type: fc.constant("went-through" as const), toolUseId: fc.constantFrom(...IDS).map((id) => `tu-${id}`), toolInput: fc.constantFrom(...IDS, "x").map((id) => ({ id })) }),
  fc.record({ type: fc.constant("failed" as const), toolUseId: fc.constantFrom(...IDS).map((id) => `tu-${id}`) }),
  fc.constant({ type: "turn-started" as const }),
  fc.constant({ type: "turn-ended" as const }),
  fc.record({ type: fc.constant("answered" as const), id: fc.constantFrom(...IDS) }),
);

describe("outputs", () => {
  test("an output opens only with its own id, stays its own turn, and closes when the next turn ends", () => {
    fc.assert(
      fc.property(fc.array(outputsEvent, { minLength: 10, maxLength: 60, size: "max" }), (events) => {
        let outputs: Outputs = NO_OUTPUTS;
        for (const event of events) {
          const before = outputs;
          const step = stepOutputs(outputs, event);
          outputs = step.outputs;
          const newlyOpen = outputs.open.filter((output) => !before.open.includes(output));
          if (newlyOpen.length > 0) {
            if (event.type !== "went-through" || newlyOpen.length !== 1) return false;
            const sent = before.pending.find(({ toolUseId }) => toolUseId === event.toolUseId);
            if (!sent || newlyOpen[0].id !== sent.id || (event.toolInput as { id: string }).id !== sent.id) return false;
          }
          // A failed call drops only its own pending output.
          if (event.type === "failed" && outputs.pending.length !== before.pending.filter(({ toolUseId }) => toolUseId !== event.toolUseId).length) return false;
          if (step.closedIds.some((id) => !before.open.some((output) => output.id === id))) return false;
          if (event.type === "turn-ended") {
            if (outputs.open.some(({ askedInTurn }) => askedInTurn < outputs.turn)) return false;
            if (before.open.some((output) => output.askedInTurn === before.turn && !outputs.open.includes(output))) return false;
          }
          if (outputs.open.length > SESSION_LIMITS.maxOpenOutputs || outputs.pending.length > SESSION_LIMITS.maxOpenOutputs) return false;
        }
        return true;
      }),
      RUNS,
    );
  });
});

// Entries over a few ids, valid and not, so merges overlap.
const entryId = fc.constantFrom("e1", "e2", "e3", "e4", "dropped:1", "dropped:2");
const sessionEntry: fc.Arbitrary<SessionEntry> = fc.oneof(
  fc.record({ kind: fc.constant("text" as const), entryId, text: fc.string({ maxLength: 30 }) }),
  fc.record({ kind: fc.constant("tool" as const), entryId, toolName: fc.constant("Bash"), summary: fc.string({ maxLength: 10 }), outcome: fc.constantFrom("running" as const, "done" as const, "failed" as const) }),
  fc.record({ kind: fc.constant("dropped" as const), entryId, droppedKind: fc.constant("text"), reason: fc.constant("failed its check") }),
);
const markerCount = (entries: SessionEntry[]) => entries.filter(({ kind }) => kind === "dropped").length;

describe("entries", () => {
  // Kept entries and a resend are windows of one session's history: what's kept
  // ends somewhere, and a resend runs up to the newest. Two copies of one entry
  // can differ (a tool that ended). Outside that shape the order alone can't
  // tell an old entry from a new one.
  // Some entries are big, so the kept text budget trims too, not only maxKept.
  const bigText = "x".repeat(SESSION_LIMITS.maxKeptEntryTextLength / 3);
  const historyEntry = fc.oneof(sessionEntry, fc.record({ kind: fc.constant("text" as const), entryId, text: fc.constant(bigText) }));
  const historyWindows = fc
    .record({ historyLength: fc.integer({ min: 1, max: 16 }), maxKept: fc.integer({ min: 1, max: 10 }), keptEnd: fc.nat(), keptLength: fc.nat(), resendStart: fc.nat() })
    .chain(({ historyLength, maxKept, keptEnd, keptLength, resendStart }) => {
      const keptEndPosition = keptEnd % (historyLength + 1);
      const keptStart = Math.max(keptEndPosition - (keptLength % (maxKept + 1)), 0);
      const resendStartPosition = Math.max(resendStart % historyLength, historyLength - maxKept);
      return fc.record({
        firstCopies: fc.array(historyEntry, { minLength: historyLength, maxLength: historyLength }),
        laterCopies: fc.array(historyEntry, { minLength: historyLength, maxLength: historyLength }),
      }).map(({ firstCopies, laterCopies }) => {
        const withId = (entries: SessionEntry[]) => entries.map((entry, position): SessionEntry => ({ ...entry, entryId: `h${position}` }));
        return { kept: withId(firstCopies).slice(keptStart, keptEndPosition), resend: withId(laterCopies).slice(resendStartPosition), maxKept };
      });
    });
  test("merging the same resend twice gives the same result as once", () => {
    fc.assert(
      fc.property(historyWindows, ({ kept, resend, maxKept }) => {
        const once = mergeSessionEntries(kept, resend, maxKept);
        return JSON.stringify(mergeSessionEntries(once, resend, maxKept)) === JSON.stringify(once);
      }),
      RUNS,
    );
  });
  test("a merge keeps at most maxKept entries and maxDroppedKept markers", () => {
    fc.assert(
      fc.property(fc.array(sessionEntry, { maxLength: 40 }), fc.array(sessionEntry, { maxLength: 40 }), fc.integer({ min: 1, max: 30 }), (kept, added, maxKept) => {
        const merged = mergeSessionEntries(kept, added, maxKept);
        return merged.length <= maxKept && markerCount(merged) <= SESSION_LIMITS.maxDroppedKept;
      }),
      RUNS,
    );
  });
  test("capping markers leaves at most the cap, and every other entry", () => {
    fc.assert(
      fc.property(fc.array(sessionEntry, { maxLength: 40 }), fc.integer({ min: 1, max: 5 }), (entries, cap) => {
        const capped = capDroppedMarkers(entries, cap);
        const others = (list: SessionEntry[]) => list.filter(({ kind }) => kind !== "dropped");
        return markerCount(capped) <= cap && JSON.stringify(others(capped)) === JSON.stringify(others(entries));
      }),
      RUNS,
    );
  });
});

describe("readSessionEntries", () => {
  test("it never throws, and every entry it gives back is one it accepts, within the marker cap", () => {
    const item = fc.oneof(sessionEntry, fc.jsonValue(), fc.record({ kind: fc.constantFrom("text", "prompt", "output"), entryId: fc.oneof(entryId, fc.string()), text: fc.jsonValue() }));
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.array(item, { maxLength: 30 })), (value) => {
        const entries = readSessionEntries(value);
        if (entries === null) return true;
        return entries.every((entry) => JSON.stringify(readSessionEntry(entry)) === JSON.stringify(entry)) && markerCount(entries) <= SESSION_LIMITS.maxDroppedPerBatch;
      }),
      RUNS,
    );
  });
});

describe("readSessionEntries marker cap", () => {
  test("a batch of the same bad item, repeated, keeps at most the cap of markers", () => {
    const badItem = fc.oneof(fc.constant({}), fc.record({ kind: fc.constant("text"), entryId: entryId, text: fc.integer() }));
    fc.assert(
      fc.property(badItem, fc.integer({ min: 1, max: 60 }), (item, copies) => {
        const entries = readSessionEntries(Array.from({ length: copies }, () => item));
        return entries !== null && markerCount(entries) <= SESSION_LIMITS.maxDroppedPerBatch;
      }),
      RUNS,
    );
  });
});
