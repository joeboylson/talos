import { expect, test } from "bun:test";
import { readSettingsRow } from "../../settings-table";

test("a fresh server has new people switched off", () => {
  expect(readSettingsRow(undefined)).toEqual({ allowNewPeople: false });
});

test.each([
  ["true", { allowNewPeople: true }, true],
  ["false", { allowNewPeople: false }, false],
  ["the text 'true'", { allowNewPeople: "true" }, false],
  ["missing", {}, false],
])("allowNewPeople stored as %s reads as %p", (_label, row, expected) => {
  expect(readSettingsRow(row).allowNewPeople).toBe(expected);
});
