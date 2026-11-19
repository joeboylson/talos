import { describe, expect, test } from "bun:test";
import {
  appendOutput,
  buildMessageWithImages,
  buildPastedText,
  isDraftChangingKeys,
  isDraftClearingKeys,
  isTurnChangingKeys,
  removeControlCharacters,
} from "../../terminal";

test("buildPastedText pastes the whole text as one piece", () => {
  expect(buildPastedText("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~");
});

test("buildMessageWithImages puts each image's path after the text", () => {
  expect(buildMessageWithImages(" look ", ["/u/a.png", "/u/b.png"])).toBe("look\n\n/u/a.png\n\n/u/b.png");
  expect(buildMessageWithImages("", ["/u/a.png"])).toBe("/u/a.png");
});

test("appendOutput keeps only the most recent bytes", () => {
  const output = appendOutput(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), 4);
  expect([...output]).toEqual([2, 3, 4, 5]);
  expect([...appendOutput(new Uint8Array(), new Uint8Array([1]), 4)]).toEqual([1]);
});

test("a message can't end the paste early and type keystrokes", () => {
  const sneaky = "hello\x1b[201~\r!rm -rf ~\r";
  expect(buildPastedText(sneaky)).toBe("\x1b[200~hello[201~!rm -rf ~\x1b[201~");
});

test("removeControlCharacters keeps line breaks and tabs only", () => {
  expect(removeControlCharacters("a\nb\tc\x00d\x07e\x9bf\x7fg")).toBe("a\nb\tcdefg");
});

describe("isTurnChangingKeys", () => {
  test.each([
    ["Enter", "\r", true],
    ["a typed line and Enter", "fix it\r", true],
    ["a lone Esc", "\x1b", true],
    ["Ctrl-C", "\x03", true],
    ["a double Esc", "\x1b\x1b", true],
    ["Esc in kitty key encoding", "\x1b[27u", true],
    ["Ctrl-C in kitty key encoding", "\x1b[99;5u", true],
    ["Ctrl-C in modifyOtherKeys encoding", "\x1b[27;5;99~", true],
    ["an arrow key", "\x1b[A", false],
    ["Page Up", "\x1b[5~", false],
    ["plain letters", "abc", false],
    ["nothing", "", false],
  ])("%s → %p", (_name, keys, expected) => {
    expect(isTurnChangingKeys(new TextEncoder().encode(keys))).toBe(expected);
  });
});

describe("isDraftChangingKeys", () => {
  test.each([
    ["a letter", "a", true],
    ["a pasted line", "fix the build", true],
    ["Backspace", "\x7f", true],
    ["Up, recalling an old message", "\x1b[A", true],
    ["Down in application mode", "\x1bOB", true],
    ["a pasted block", "\x1b[200~two\rlines\x1b[201~", true],
    ["letters glued after Left", "\x1b[Dabc", true],
    ["a letter glued after a focus report", "\x1b[Ia", true],
    ["Left", "\x1b[D", false],
    ["a kitty key report", "\x1b[?1u", false],
    ["a focus-in report", "\x1b[I", false],
    ["a cursor position report", "\x1b[12;40R", false],
    ["nothing", "", false],
  ])("%s → %p", (_name, keys, expected) => {
    expect(isDraftChangingKeys(new TextEncoder().encode(keys))).toBe(expected);
  });
});

describe("isDraftClearingKeys", () => {
  test.each([
    ["Enter", "\r", true],
    ["a line and Enter", "fix it\r", true],
    ["Ctrl-C", "\x03", true],
    ["Ctrl-C in kitty key encoding", "\x1b[99;5u", true],
    ["Option-Enter, which only adds a line", "\x1b\r", false],
    ["a pasted block with a line break", "\x1b[200~two\rlines\x1b[201~", false],
    ["a letter", "a", false],
    ["nothing", "", false],
  ])("%s → %p", (_name, keys, expected) => {
    expect(isDraftClearingKeys(new TextEncoder().encode(keys))).toBe(expected);
  });
});
