import { describe, expect, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { DECISION_KIND, OUTPUT_KINDS, PROSE_TURN, STATUS_KIND, readDecision, readStatusReport } from "../../session-outputs";
import { PROSE, catalogProblems } from "../../talos-sessions";

describe("status", () => {
  test.each([
    ["an unknown state", { state: "great", note: "x" }],
    ["a note that isn't text", { state: "done", note: 5 }],
    ["a note too long", { state: "done", note: "x".repeat(LIMITS.maxStatusNoteLength + 1) }],
    ["no input", null],
  ])("%s is turned down", (_name, toolInput) => {
    expect(readStatusReport(toolInput)).toBeNull();
  });
  test("the note has no control characters or line breaks", () => {
    expect(readStatusReport({ state: "done", note: "line1\nline2\t\u001b[31mred" })).toEqual({ state: "done", note: "line1 line2 [31mred" });
  });
});

describe("decision", () => {
  const good = { question: "Which database?", choices: ["Postgres", "SQLite"] };
  test("a good one is kept", () => {
    expect(readDecision(good)).toEqual(good);
  });
  test.each([
    ["one choice", { ...good, choices: ["Postgres"] }],
    ["five choices", { ...good, choices: ["a", "b", "c", "d", "e"] }],
    ["a choice that's only control characters", { ...good, choices: ["Postgres", "\u001b\u0007"] }],
    ["an empty question", { ...good, question: "  " }],
    ["a question too long", { ...good, question: "x".repeat(LIMITS.maxDecisionQuestionLength + 1) }],
    ["no input", null],
  ])("%s is turned down", (_name, toolInput) => {
    expect(readDecision(toolInput)).toBeNull();
  });
  test("the question and choices have no control characters or line breaks", () => {
    expect(readDecision({ question: "Which\n\u001b[31mone?", choices: ["a\tb", "c"] })).toEqual({ question: "Which [31mone?", choices: ["a b", "c"] });
  });
  test.each([
    ["only a blank-looking filler", "\u3164"],
    ["the same as the other choice once cleaned", "Fine "],
  ])("a choice that's %s is turned down", (_name, choice) => {
    expect(readDecision({ question: "Which?", choices: ["Fine", choice] })).toBeNull();
  });
  test("its choices are typed as the person's message, so talos-sessions checks them for commands", () => {
    expect(DECISION_KIND.typedFields.choices).toEqual({ allowCommands: false });
    expect(DECISION_KIND.choicesField).toBe("choices");
  });
});

describe("limits, at the edge", () => {
  const good = { question: "Which?", choices: ["Yes", "No"] };
  const choicesOf = (count: number) => Array.from({ length: count }, (_unused, index) => `choice ${index}`);
  test("a status note at its limit is kept, one over is turned down", () => {
    expect(readStatusReport({ state: "done", note: "x".repeat(LIMITS.maxStatusNoteLength) })).not.toBeNull();
    expect(readStatusReport({ state: "done", note: "x".repeat(LIMITS.maxStatusNoteLength + 1) })).toBeNull();
  });
  test("a question at its limit is kept", () => {
    expect(readDecision({ ...good, question: "x".repeat(LIMITS.maxDecisionQuestionLength) })).not.toBeNull();
  });
  test("a choice at its limit is kept, one over is turned down", () => {
    expect(readDecision({ ...good, choices: ["Yes", "x".repeat(LIMITS.maxDecisionChoiceLength)] })).not.toBeNull();
    expect(readDecision({ ...good, choices: ["Yes", "x".repeat(LIMITS.maxDecisionChoiceLength + 1)] })).toBeNull();
  });
  test("the most choices allowed are kept", () => {
    expect(readDecision({ ...good, choices: choicesOf(LIMITS.maxDecisionChoices) })).not.toBeNull();
  });
  test.each([[5], [{ length: 3 }]])("a choice that isn't text (%p) is turned down, not thrown on", (choice) => {
    expect(readDecision({ ...good, choices: ["Yes", choice] })).toBeNull();
  });
});

describe("talos's kinds, as the session runner gets them", () => {
  test("a decision may be sent in a normal turn; a status may not", () => {
    expect(PROSE_TURN).toEqual({ output: PROSE, optional: [DECISION_KIND.kind] });
  });
  test("a decision waits for its answer; a status doesn't, and is only asked for", () => {
    expect(DECISION_KIND.waits).toBe(true);
    expect(STATUS_KIND.waits).toBe(false);
    expect(STATUS_KIND.requestText).toContain(STATUS_KIND.toolName);
  });
  test("both kinds are passed in, each with its own tool", () => {
    expect(OUTPUT_KINDS.map(({ kind, toolName }) => [kind, toolName])).toEqual([["status", "report_status"], ["decision", "ask_decision"]]);
  });
});

test("talos's own kinds pass the session runner's start check", () => {
  expect(catalogProblems({ kinds: OUTPUT_KINDS, proseTurn: PROSE_TURN })).toEqual([]);
});
