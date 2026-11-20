import { expect, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { canSendMessage, isSendKey, takeImagesThatFit } from "../../compose-message";

test.each([
  ["hi", 0, true],
  ["", 1, true],
  ["", 0, false],
  ["  \n ", 0, false],
] as const)("canSendMessage(%p, %p images) is %p", (text, imageCount, expected) => {
  expect(canSendMessage(text, imageCount)).toBe(expected);
});

test.each([
  ["Enter", false, true],
  ["Enter", true, false],
  ["a", false, false],
] as const)("isSendKey(%p, shift %p) is %p", (key, shiftKey, expected) => {
  expect(isSendKey({ key, shiftKey })).toBe(expected);
});

test("takeImagesThatFit takes only the room left", () => {
  const files = ["a", "b", "c", "d", "e"];
  expect(takeImagesThatFit(files, 0)).toHaveLength(LIMITS.maxImagesPerMessage);
  expect(takeImagesThatFit(files, LIMITS.maxImagesPerMessage - 1)).toEqual(["a"]);
  expect(takeImagesThatFit(files, LIMITS.maxImagesPerMessage)).toEqual([]);
});
