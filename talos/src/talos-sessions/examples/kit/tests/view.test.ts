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

test("each Backspace or Ctrl-H in one piece of keys takes a character", () => {
  expect(typeIntoDraft("abc", "\x7f\x7f").draft).toBe("a");
  expect(typeIntoDraft("abc", "d\x7f").draft).toBe("abc");
  expect(typeIntoDraft("abc", "\x08").draft).toBe("ab");
  expect(typeIntoDraft("", "hi\rno\x7f\x7fok")).toEqual({ draft: "ok", sent: ["hi"] });
});
