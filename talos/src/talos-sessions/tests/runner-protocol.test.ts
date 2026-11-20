import { describe, expect, test } from "bun:test";
import { encodeHookLine, readHookAnswer, readHookRequest } from "../client/runner-protocol";

describe("the hooks socket's line exchange", () => {
  test("a request comes back as it went", () => {
    const request = { sessionName: "fix", token: "t", details: '{"hook_event_name":"Stop"}\nmore' };
    const line = encodeHookLine(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(readHookRequest(line.trimEnd())).toEqual(request);
  });
  test("an answer comes back as it went", () => {
    expect(readHookAnswer(encodeHookLine({ kind: "reply", reply: "{}" }).trimEnd())).toEqual({ kind: "reply", reply: "{}" });
    expect(readHookAnswer(encodeHookLine({ kind: "too-big" }).trimEnd())).toEqual({ kind: "too-big" });
  });
  test.each([
    ["not JSON", "nope"],
    ["a missing token", JSON.stringify({ sessionName: "fix", details: "{}" })],
    ["details that aren't text", JSON.stringify({ sessionName: "fix", token: "t", details: {} })],
  ])("a request that's %s is turned down", (_name, line) => {
    expect(readHookRequest(line)).toBeNull();
  });
  test("an unknown answer is turned down", () => {
    expect(readHookAnswer(JSON.stringify({ kind: "maybe" }))).toBeNull();
  });
});
