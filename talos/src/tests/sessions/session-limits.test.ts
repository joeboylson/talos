import { describe, expect, test } from "bun:test";
import { LIMITS, isIdentifierName as sharedIsIdentifierName } from "talos-shared";
import { COPIED_LIMITS, isIdentifierName } from "../../talos-sessions";

// talos-sessions can't import talos-shared, so it keeps copies of what both
// check. These fail if a copy drifts from talos-shared's.
describe("talos-sessions' copies of talos-shared's rules", () => {
  test.each(Object.entries(COPIED_LIMITS))("%s matches", (name, value) => {
    expect(value).toBe(LIMITS[name as keyof typeof LIMITS]);
  });

  const names = ["fix-login", "a", "a1-b2", "x".repeat(40), "x".repeat(41), "", "Fix", "-a", "a-", "a--b", "a_b", "../x", "a.local", "unnamed", 7, null];
  test.each(names.map((name) => [name]))("the name rule agrees on %p", (name) => {
    expect(isIdentifierName(name)).toBe(sharedIsIdentifierName(name));
  });
});
