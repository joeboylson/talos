import { expect, test } from "bun:test";
import { parseThemeChoice, resolveTheme } from "../../theme";

test.each([
  ["light", false, "light"],
  ["light", true, "light"],
  ["dark", false, "dark"],
  ["dark", true, "dark"],
  ["system", false, "light"],
  ["system", true, "dark"],
] as const)("resolveTheme(%p, prefersDark %p) is %p", (choice, prefersDark, expected) => {
  expect(resolveTheme(choice, prefersDark)).toBe(expected);
});

test.each([
  ["light", "light"],
  ["dark", "dark"],
  ["system", "system"],
  [null, "system"],
  ["purple", "system"],
  ["", "system"],
] as const)("parseThemeChoice(%p) is %p", (storedValue, expected) => {
  expect(parseThemeChoice(storedValue)).toBe(expected);
});
