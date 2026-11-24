import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { interruptLine, permissionAnswerLine, readStreamLine, userMessageLine, type StreamEvent } from "../stream/stream-lines";
import { numberItems, readTranscriptLine, resolveTranscriptItems, type TranscriptItem } from "../transcript/transcript-lines";

// Recorded from the pinned Claude Code run headless with the stand-in model
// (ref/mod-test-results.md, "Headless probe"), paths replaced: its output
// stream, and the conversation files it saved for the same run.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "headless", name), "utf8").split("\n").filter(Boolean);
const STREAM = fixture("stream.jsonl");
const SAVED = fixture("transcript.jsonl");

const entriesOf = (items: TranscriptItem[]) => resolveTranscriptItems(numberItems(items, 0).items, new Map()).entries;
const streamEvents = STREAM.map(readStreamLine).filter((event): event is StreamEvent => event !== null);
const conversationItems = streamEvents.flatMap((event) => (event.type === "conversation" ? event.items : []));

describe("the stream gives the conversation the saved file does", () => {
  test("every entry matches, but the slash commands talos sent, which the stream doesn't echo", () => {
    const withoutPlace = (entries: ReturnType<typeof entriesOf>) => entries.map(({ position: _position, ...entry }) => entry);
    const fromStream = withoutPlace(entriesOf(conversationItems));
    const fromFile = withoutPlace(entriesOf(SAVED.flatMap(readTranscriptLine))).filter((entry) => !(entry.kind === "prompt" && entry.text.startsWith("/")));
    // The stream's last entry, /fork's answer, went to a file the probe didn't keep.
    expect(fromStream.slice(0, -1)).toEqual(fromFile);
  });
});

describe("reading the stream", () => {
  test("each turn ends with one result, an interrupted one as an error", () => {
    const ends = streamEvents.filter((event) => event.type === "turn-over");
    expect(ends.length).toBe(STREAM.filter((line) => JSON.parse(line).type === "result").length);
    expect(ends.filter((event) => event.type === "turn-over" && event.isError)).toHaveLength(1);
  });
  test("a permission question names its call, tool and input", () => {
    const asks = streamEvents.filter((event) => event.type === "permission-ask");
    expect(asks).toEqual([{ type: "permission-ask", requestId: expect.any(String), toolUseId: expect.stringMatching(/^toolu_/), tool: "Bash", input: { command: "touch made-by-probe", description: "make a file" } }]);
  });
  test("the start says the session's id, and /clear the new conversation's", () => {
    expect(streamEvents[1]).toEqual({ type: "init", sessionId: expect.any(String) });
    expect(streamEvents.filter((event) => event.type === "reset")).toEqual([{ type: "reset", conversationId: expect.any(String) }]);
  });
  test.each([
    ["a sub-agent's line", JSON.stringify({ type: "assistant", uuid: "u", parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "hi" }] } })],
    ["not JSON", "{"],
    ["an unknown line", JSON.stringify({ type: "rate_limit_event" })],
    ["a control request that isn't a permission question", JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "hook_callback" } })],
    ["a permission question with no call id", JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "Bash" } })],
  ])("%s means nothing", (_name, line) => {
    expect(readStreamLine(line)).toBeNull();
  });
  test("a cancelled question and a control answer name their request", () => {
    expect(readStreamLine(JSON.stringify({ type: "control_cancel_request", request_id: "r1" }))).toEqual({ type: "permission-cancel", requestId: "r1" });
    expect(readStreamLine(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "r2", error: "x" } }))).toEqual({ type: "control-answer", requestId: "r2", isOk: false });
  });
});

describe("writing to the stream", () => {
  test("a message is one line, its images first", () => {
    expect(userMessageLine("hi")).toBe(`${JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null, session_id: "" })}\n`);
    const withImage = JSON.parse(userMessageLine("look", [{ mediaType: "image/png", dataBase64: "AA==" }]));
    expect(withImage.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "look" }]);
    expect(userMessageLine("a\nb").indexOf("\n")).toBe(userMessageLine("a\nb").length - 1);
    expect(JSON.parse(userMessageLine("", [{ mediaType: "image/png", dataBase64: "AA==" }])).message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]);
  });
  test("an interrupt and permission answers are control lines", () => {
    expect(JSON.parse(interruptLine("r1"))).toEqual({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
    expect(JSON.parse(permissionAnswerLine("r2", "tu1", { allow: true, input: { command: "ls" } })).response).toEqual({
      subtype: "success",
      request_id: "r2",
      response: { behavior: "allow", updatedInput: { command: "ls" }, toolUseID: "tu1" },
    });
    expect(JSON.parse(permissionAnswerLine("r3", "tu2", { allow: false, message: "no" })).response.response).toEqual({ behavior: "deny", message: "no", toolUseID: "tu2" });
  });
});
