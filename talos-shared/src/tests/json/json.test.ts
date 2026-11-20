import { expect, test } from "bun:test";
import { parseJsonOrNull } from "../../json";

test("parseJsonOrNull reads JSON, and bad JSON is null", () => {
  expect(parseJsonOrNull('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonOrNull("{bad")).toBeNull();
});
