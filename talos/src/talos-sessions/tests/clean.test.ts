import { describe, expect, test } from "bun:test";
import { cleanLine, hasCommandMarker, saysSomething } from "../clean";

describe("cleanLine", () => {
  test("runs of spaces, tabs and line breaks become one space", () => {
    expect(cleanLine("a \t\n  b")).toBe("a b");
  });
  test("a combining mark after a letter stays", () => {
    expect(cleanLine("café")).toBe("café");
  });
  test("leading marks and spaces go together, so cleaning again changes nothing", () => {
    expect(cleanLine("̈ a")).toBe("a");
    expect(cleanLine(" ̈ ̈/x")).toBe("/x");
  });
  test("a command marker a mark hid shows once cleaned", () => {
    expect(hasCommandMarker(cleanLine("̈ ̈/clear"))).toBe(true);
  });
});

describe("hasCommandMarker", () => {
  test.each(["/clear", "ok !rm", "#note", "@file", "ok。@~/.ssh/id_rsa", "yes！@\"/a b.txt\"", "a、@x", "joe@example.com"])("%p could act in Claude Code", (text) => {
    expect(hasCommandMarker(text)).toBe(true);
  });
  test.each(["Business", "Personal", "a/b", "50% off!", "＠full-width"])("%p is plain text", (text) => {
    expect(hasCommandMarker(text)).toBe(false);
  });
});

describe("saysSomething", () => {
  test.each([
    ["...", false],
    ["", false],
    ["7", true],
    ["ok", true],
  ])("%p → %p", (text, expected) => {
    expect(saysSomething(text)).toBe(expected);
  });
});
