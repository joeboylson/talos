import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "../../../index";
import { readRecording, replay } from "../../kit/recording";
import { fitScreen } from "../../kit/screen";
import type { Input } from "../../kit/view";
import { KINDS, PROSE_TURN, QUESTION, TALLY, readExpense, readQuestion, readTally } from "../kinds";
import { START_MESSAGE, receiptsView, type ReceiptsState } from "../view";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const expense = { file: "01-train.txt", date: "2025-03-03", shop: "Northern Rail", amount: 24.6, currency: "GBP", category: "travel" };

describe("receipts' kinds", () => {
  test("a good expense is kept", () => {
    expect(readExpense(expense)).toEqual(expense);
  });
  test.each([
    ["a date that isn't one", { ...expense, date: "2025-02-30" }],
    ["an amount that isn't a number", { ...expense, amount: "24.60" }],
    ["a negative amount", { ...expense, amount: -1 }],
    ["an amount too big to be a receipt", { ...expense, amount: 1e20 }],
    ["a currency that isn't a code", { ...expense, currency: "£" }],
    ["a category not on the list", { ...expense, category: "fun" }],
  ])("an expense with %s is turned down", (_name, input) => {
    expect(readExpense(input)).toBeNull();
  });
  test("a question needs 2 to 4 different choices, typed in without commands", () => {
    expect(readQuestion({ file: "07.txt", question: "Business expense?", choices: ["Business", "Personal"] })).not.toBeNull();
    expect(readQuestion({ file: "07.txt", question: "?", choices: ["Same", "Same"] })).toBeNull();
    expect(readQuestion({ file: "07.txt", question: "Business expense?", choices: [" \u200b", "Personal"] })).toBeNull();
    expect(QUESTION).toMatchObject({ waits: true, choicesField: "choices", typedFields: { choices: { allowCommands: false } } });
  });
  test("a tally is only asked for, and its totals are checked", () => {
    expect(TALLY.requestText).toBeTruthy();
    expect(PROSE_TURN.optional).not.toContain("tally");
    expect(readTally({ totals: [{ category: "travel", currency: "GBP", amount: 24.6 }] })).not.toBeNull();
    expect(readTally({ totals: [{ category: "travel", currency: "GBP", amount: "lots" }] })).toBeNull();
    const meals = { category: "meals", currency: "GBP", amount: 1 };
    expect(readTally({ totals: [meals, { ...meals, amount: 9999 }] })).toBeNull();
    expect(KINDS.map(({ kind }) => kind)).toEqual(["expense", "skipped", "question", "tally"]);
  });
});

describe("the view", () => {
  const session = (extra: Partial<SessionSummary>): Input => ({
    type: "event",
    event: { type: "sessions", sessions: [{ sessionName: "example", folderName: "work", state: "idle", asks: {}, openOutputs: [], ...extra }] },
  });
  const expenseEntry: Input = { type: "event", event: { type: "session-entries", sessionName: "example", entries: [{ kind: "output", position: 1, entryId: "e1", outputKind: "expense", fields: expense }] } };
  const question = { id: "q1", kind: "question", fields: { file: "07-dinner.txt", question: "Business expense?", choices: ["Business", "Personal"] }, atMs: 0 };
  const play = (inputs: Input[]) =>
    inputs.reduce((played, input) => {
      const { state, actions } = receiptsView.step(played.state, input);
      return { state, actions: [...played.actions, ...actions] };
    }, { state: receiptsView.initial as ReceiptsState, actions: [] as unknown[] });

  test("starting sends the sorting request", () => {
    expect(play([{ type: "started" }]).actions).toEqual([{ do: "send", text: START_MESSAGE }]);
  });
  test("a number answers the open question by its id; a number past its choices does nothing", () => {
    expect(play([session({ state: "needs-you", openOutputs: [question] }), { type: "key", key: "2" }]).actions).toEqual([{ do: "answer", outputId: "q1", choice: 1 }]);
    expect(play([session({ state: "needs-you", openOutputs: [question] }), { type: "key", key: "3" }]).actions).toEqual([]);
  });
  test("the tally is asked for once, only when idle with expenses and no question open", () => {
    expect(play([expenseEntry, session({ state: "needs-you", openOutputs: [question] })]).actions).toEqual([]);
    expect(play([expenseEntry, session({ state: "working" })]).actions).toEqual([]);
    expect(play([expenseEntry, session({ state: "idle" }), session({ state: "idle" })]).actions).toEqual([{ do: "ask", kind: "tally" }]);
  });
  const expenseOf = (entryId: string, amount: number): Input => ({
    type: "event",
    event: { type: "session-entries", sessionName: "example", entries: [{ kind: "output", position: Number(entryId.slice(1)), entryId, outputKind: "expense", fields: { ...expense, amount } }] },
  });
  const tallyAsk = (state: "asking" | "answered" | "no-response") => session({ state: "idle", asks: { tally: { state, atMs: 0 } } });
  const asks = (inputs: Input[]) => play(inputs).actions.filter((action) => (action as { do: string }).do === "ask").length;
  test("a tally ask that's refused or gets no response is asked again at the next idle", () => {
    const refused: Input = { type: "result", action: { do: "ask", kind: "tally" }, result: { ok: false, code: "already-asking", reason: "busy" } };
    expect(asks([expenseEntry, session({ state: "idle" }), refused, session({ state: "idle" })])).toBe(2);
    expect(asks([expenseEntry, session({ state: "idle" }), tallyAsk("no-response"), session({ state: "idle" })])).toBe(2);
    expect(asks([expenseEntry, session({ state: "idle" }), tallyAsk("asking"), tallyAsk("asking")])).toBe(1);
  });
  test("expenses sent after the tally was asked for are counted in a new one", () => {
    expect(asks([expenseOf("e1", 10), session({ state: "idle" }), tallyAsk("answered"), expenseOf("e2", 32.5), session({ state: "working" }), session({ state: "idle" })])).toBe(2);
    expect(asks([expenseOf("e1", 10), session({ state: "idle" }), tallyAsk("answered"), session({ state: "idle" })])).toBe(1);
  });
  test("a question's answer goes once, however often its key is pressed", () => {
    const open = session({ state: "needs-you", openOutputs: [question] });
    expect(play([open, { type: "key", key: "1" }, { type: "key", key: "2" }]).actions).toEqual([{ do: "answer", outputId: "q1", choice: 0 }]);
  });
  test("a refusal shows its reason", () => {
    const { state } = play([{ type: "result", action: { do: "answer", outputId: "q1", choice: 0 }, result: { ok: false, code: "closed", reason: "That question has closed" } }]);
    expect(plain(receiptsView.render(state, 100)).join("\n")).toContain("That question has closed");
  });
  test("the recorded run replays: sorting, the question answered by id, then the tally", () => {
    const { state, actions, states } = replay(receiptsView, readRecording(readFileSync(join(import.meta.dir, "../recordings/run.jsonl"), "utf8")));
    // An expense read just after the session goes idle makes the tally be asked
    // again once it's in, so a recording may end with more asks.
    const done = actions.map((action) => action.do);
    expect(done.slice(0, 3)).toEqual(["send", "answer", "ask"]);
    expect(done.slice(3).every((what) => what === "ask")).toBe(true);
    expect(states.some((one) => one.question?.fields.file === "07-dinner.txt")).toBe(true);
    const screen = plain(receiptsView.render(state, 100));
    expect(screen.filter((line) => /\d\.\d\d [A-Z]{3}/.test(line))).toHaveLength(9);
    expect(screen).toContain("Totals");
  });
});

test("in a narrow window, every amount still shows", () => {
  const totals: Input = { type: "event", event: { type: "sessions", sessions: [{ sessionName: "example", folderName: "work", state: "idle", asks: { tally: { state: "answered", atMs: 0, latest: { totals: [{ category: "travel", currency: "GBP", amount: 1234.5 }, { category: "meals", currency: "GBP", amount: 12 }] } } }, openOutputs: [] }] } };
  const expenseRow: Input = { type: "event", event: { type: "session-entries", sessionName: "example", entries: [{ kind: "output", position: 1, entryId: "e1", outputKind: "expense", fields: expense }] } };
  const state = [expenseRow, totals].reduce((current, input) => receiptsView.step(current, input).state, receiptsView.initial as ReceiptsState);
  const screen = plain(fitScreen(receiptsView.render(state, 40), 40, 100)).join("\n");
  expect(screen).toContain("1234.50");
  expect(screen).toContain("12.00");
  expect(screen).toContain("24.60 GBP");
});
