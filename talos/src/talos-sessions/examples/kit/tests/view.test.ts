import { expect, test } from "bun:test";
import { BACKSPACE, typeIntoDraft } from "../view";

test("F1–F4 and keys in application mode type nothing", () => {
  expect(typeIntoDraft("hi", "\x1bOP\x1bOQ\x1bOR\x1bOS\x1bOA\x1bOH").draft).toBe("hi");
  expect(typeIntoDraft("hi", "\x1b[<0;12;5M").draft).toBe("hi");
});

test("Backspace takes off a whole character, an emoji included", () => {
  expect(typeIntoDraft("hi 😀", BACKSPACE).draft).toBe("hi ");
  expect(typeIntoDraft("ok 👍🏽", BACKSPACE).draft).toBe("ok ");
});
