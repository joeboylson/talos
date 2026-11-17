import { expect, test } from "bun:test";
import { requireEnv } from "../../env";

test("requireEnv returns a set value", () => {
  expect(requireEnv("SOME_KEY", { SOME_KEY: "value" })).toBe("value");
});

test("requireEnv throws for a missing or empty value", () => {
  expect(() => requireEnv("SOME_KEY", {})).toThrow("SOME_KEY is not set");
  expect(() => requireEnv("SOME_KEY", { SOME_KEY: "" })).toThrow("SOME_KEY is not set");
});
