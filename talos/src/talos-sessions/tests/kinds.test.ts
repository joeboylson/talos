import { describe, expect, test } from "bun:test";
import { ID_PLACEHOLDER, OUTPUT_ID_FIELD, listedSchema, replyWording, type OutputKind } from "../kinds";

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

describe("what the session's MCP server lists", () => {
  test("the schema keeps the kind's fields and adds the optional id talos sets", () => {
    expect(listedSchema(kind)).toEqual({
      type: "object",
      properties: { text: { type: "string" }, [OUTPUT_ID_FIELD]: { type: "string", description: "set by talos; leave it out" } },
      required: ["text"],
    });
  });
  test("a kind that waits tells the session to end its turn; one that doesn't, doesn't", () => {
    expect(replyWording(kind)).toBe(`Asked as ${ID_PLACEHOLDER}. End your turn and wait.`);
    expect(replyWording({ ...kind, waits: false })).toBe(`Recorded as ${ID_PLACEHOLDER}.`);
  });
});
