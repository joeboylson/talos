import { describe, expect, test } from "bun:test";
import { ID_PLACEHOLDER, catalogProblems, replyWording, type OutputKind } from "../kinds";

const kind: OutputKind = {
  kind: "note",
  toolName: "send_note",
  description: "d",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readFields: () => null,
  badInputReason: "bad",
  typedFields: {},
  waits: true,
};

describe("what the session reads back", () => {
  test("a kind that waits tells the session to end its turn; one that doesn't, doesn't", () => {
    expect(replyWording(kind)).toBe(`Asked as ${ID_PLACEHOLDER}. End your turn and wait.`);
    expect(replyWording({ ...kind, waits: false })).toBe(`Recorded as ${ID_PLACEHOLDER}.`);
  });
});

describe("the kinds a program gives the session runner", () => {
  const kind = (fields: Partial<OutputKind>): OutputKind => ({
    kind: "note",
    toolName: "send_note",
    description: "",
    inputSchema: {},
    readFields: () => ({}),
    badInputReason: "",
    typedFields: {},
    waits: false,
    ...fields,
  });
  const problems = (kinds: OutputKind[], optional: string[] = []) => catalogProblems({ kinds, proseTurn: { output: "prose", optional } });
  test("good kinds pass", () => {
    expect(problems([kind({}), kind({ kind: "status", toolName: "send_status", requestText: "Send your status." })], ["note"])).toEqual([]);
  });
  test.each([
    ["a name that's too long", [kind({ kind: "x".repeat(101) })], []],
    ["an empty tool name", [kind({ toolName: "" })], []],
    ["two kinds of one name", [kind({}), kind({ toolName: "send_other" })], []],
    ["two kinds of one tool", [kind({}), kind({ kind: "other" })], []],
    ["choices that aren't a typed field", [kind({ choicesField: "choices" })], []],
    ["a request holding a command", [kind({ requestText: "/clear then say hi" })], []],
    ["a prose turn naming no kind", [kind({})], ["missing"]],
    ["a prose turn naming an asked-for kind", [kind({ requestText: "Send it." })], ["note"]],
  ])("%s is turned down", (_name, kinds, optional) => {
    expect(problems(kinds as OutputKind[], optional as string[]).length).toBeGreaterThan(0);
  });
  test("a prose turn whose own output is asked for, or no kind at all, is turned down", () => {
    const asked = kind({ requestText: "Send it." });
    expect(catalogProblems({ kinds: [asked], proseTurn: { output: "note", optional: [] } })).toEqual(["note is asked for, so a prose turn can't send it"]);
    expect(catalogProblems({ kinds: [kind({})], proseTurn: { output: "missing", optional: [] } })).toEqual(["the prose turn names missing, which isn't a kind"]);
    expect(catalogProblems({ kinds: [kind({})], proseTurn: { output: "note", optional: [] } })).toEqual([]);
  });
});

test("the examples' kinds all pass the start check", async () => {
  const receipts = await import("../examples/receipts/kinds");
  const explorer = await import("../examples/explorer/kinds");
  expect(catalogProblems({ kinds: receipts.KINDS, proseTurn: receipts.PROSE_TURN })).toEqual([]);
  expect(catalogProblems({ kinds: explorer.KINDS, proseTurn: explorer.PROSE_TURN })).toEqual([]);
});
