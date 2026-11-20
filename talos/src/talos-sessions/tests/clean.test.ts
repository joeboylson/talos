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
