import { describe, expect, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { DECISION_KIND, readDecision, readStatusReport } from "../../session-outputs";

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
