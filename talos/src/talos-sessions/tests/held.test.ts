import { describe, expect, test } from "bun:test";
import type { Catalog, OutputKind } from "../kinds";
import { keptHeld, nextToType, readAnswer, type HeldAnswer } from "../lanes/held";
import { NO_LANE, type Lane } from "../lanes/lane";
import { NO_OUTPUTS, type Outputs } from "../lanes/outputs";
import { SESSION_LIMITS } from "../limits";

const PICK: OutputKind = {
  kind: "pick",
  toolName: "send_pick",
  description: "pick one",
  inputSchema: { type: "object" },
  readFields: (input) => input as Record<string, unknown>,
  badInputReason: "bad",
  typedFields: { options: { allowCommands: false } },
  choicesField: "options",
  waits: true,
};
const SHOWN: OutputKind = { ...PICK, kind: "shown", choicesField: undefined };
const CATALOG: Catalog = { kinds: [PICK, SHOWN], proseTurn: { output: "prose", optional: ["pick", "shown"] } };
const outputsWith = (fields: Record<string, unknown>, kind = "pick"): Outputs => ({ ...NO_OUTPUTS, open: [{ id: "q1", kind, fields, atMs: 1, askedInTurn: 0 }] });
const OPEN = outputsWith({ options: ["Tabs", "Spaces"] });

describe("an answer by id", () => {
  test("picks from the stored choices and is typed with its id", () => {
    expect(readAnswer(OPEN, [], CATALOG, "q1", 1, 5)).toEqual({ outputId: "q1", text: "Answer to q1: Spaces", heldAtMs: 5 });
  });
  test.each([
    ["an unknown id", "nope", 0],
    ["a choice past the list", "q1", 2],
  ])("is refused for %s", (_name, outputId, choice) => {
    expect("refusal" in readAnswer(OPEN, [], CATALOG, outputId, choice, 5)).toBe(true);
  });
  test("is refused while another answer to it is held: two clicks at once answer once", () => {
    const held = readAnswer(OPEN, [], CATALOG, "q1", 0, 5) as HeldAnswer;
    expect(readAnswer(OPEN, [held], CATALOG, "q1", 1, 6)).toEqual({ refusal: "That question has closed" });
  });
  test("is refused for a kind with no choices", () => {
    expect("refusal" in readAnswer(outputsWith({ options: ["a", "b"] }, "shown"), [], CATALOG, "q1", 0, 5)).toBe(true);
  });
  test("checks the choice for a command again right before it's held", () => {
    expect(readAnswer(outputsWith({ options: ["fine", "​/clear"] }), [], CATALOG, "q1", 1, 5)).toEqual({ refusal: "That choice can't be sent" });
  });
});

describe("what goes in at the next settle", () => {
  const queued = (askedAtMs: number): Lane => ({ stage: "queued", output: "poll", askedAtMs });
  const held = (heldAtMs: number): HeldAnswer => ({ outputId: `q${heldAtMs}`, text: "x", heldAtMs });
  test("the oldest of a queued ask and the held answers, one at a time", () => {
    expect(nextToType(queued(1), [held(2)], false)).toBe("ask");
    expect(nextToType(queued(3), [held(2)], false)).toEqual(held(2));
    expect(nextToType(NO_LANE, [held(2), held(4)], false)).toEqual(held(2));
  });
  test("a draft keeps answers waiting", () => {
    expect(nextToType(NO_LANE, [held(2)], true)).toBeNull();
  });
  test("nothing held, nothing typed", () => {
    expect(nextToType(NO_LANE, [], false)).toBeNull();
  });
  test("an answer is dropped when its question closes, or at the long backstop", () => {
    expect(keptHeld([held(2), held(4)], ["q2"], 5)).toEqual([held(4)]);
    expect(keptHeld([held(2)], [], 2 + SESSION_LIMITS.queuedAskTimeoutMs + 1)).toEqual([]);
  });
});

describe("held answers among several questions", () => {
  const twoOpen: Outputs = { ...NO_OUTPUTS, open: [...OPEN.open, { id: "q2", kind: "pick", fields: { options: ["Yes", "No"] }, atMs: 1, askedInTurn: 0 }] };
  test("an answer to one question doesn't block answering another", () => {
    const held = readAnswer(twoOpen, [], CATALOG, "q1", 0, 5) as HeldAnswer;
    expect(readAnswer(twoOpen, [held], CATALOG, "q2", 1, 6)).toEqual({ outputId: "q2", text: "Answer to q2: No", heldAtMs: 6 });
  });
  test("a kind whose choices allow commands lets one through", () => {
    const LOOSE: OutputKind = { ...PICK, kind: "loose", typedFields: { options: { allowCommands: true } } };
    const looseCatalog: Catalog = { ...CATALOG, kinds: [LOOSE] };
    expect(readAnswer(outputsWith({ options: ["/clear", "keep"] }, "loose"), [], looseCatalog, "q1", 0, 5)).toEqual({ outputId: "q1", text: "Answer to q1: /clear", heldAtMs: 5 });
  });
  test("with real clock times, a fresh answer stays, one at the backstop stays, and one past it goes", () => {
    const nowMs = 1_800_000_000_000;
    const heldAt = (ageMs: number): HeldAnswer => ({ outputId: `q${ageMs}`, text: "x", heldAtMs: nowMs - ageMs });
    const atBackstop = heldAt(SESSION_LIMITS.queuedAskTimeoutMs);
    expect(keptHeld([heldAt(1000), atBackstop, heldAt(SESSION_LIMITS.queuedAskTimeoutMs + 1)], [], nowMs)).toEqual([heldAt(1000), atBackstop]);
  });
  test("an ask and an answer from the same moment: the ask goes first", () => {
    const lane: Lane = { stage: "queued", output: "poll", askedAtMs: 7 };
    expect(nextToType(lane, [{ outputId: "q1", text: "x", heldAtMs: 7 }], false)).toBe("ask");
  });
});
