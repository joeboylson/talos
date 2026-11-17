import { describe, expect, test } from "bun:test";
import { decode, encode, type ServerToMachine } from "./messages";

describe("encode and decode", () => {
  test("round-trip a message", () => {
    const ping: ServerToMachine = { type: "ping", id: "abc" };
    expect(decode<ServerToMachine>(encode(ping))).toEqual(ping);
  });

  test("decode bytes as well as strings", () => {
    const bytes = new TextEncoder().encode('{"type":"pong","id":"1"}');
    expect(decode(Buffer.from(bytes))).toEqual({ type: "pong", id: "1" });
  });

  test.each([
    ["bad JSON", "{not json"],
    ["empty string", ""],
    ["null", "null"],
    ["a number", "42"],
    ["an array", "[1,2]"],
    ["no type", '{"id":"1"}'],
    ["non-string type", '{"type":5}'],
  ])("decode returns null for %s", (_label, rawMessage) => {
    expect(decode(rawMessage)).toBeNull();
  });
});
