import { describe, expect, test } from "bun:test";
import { buildIdentifier, buildPagePath, isIdentifierName, parseIdentifier, pickUniqueName, toIdentifierName } from "../../identifiers";
import { LIMITS } from "../../limits";

describe("identifiers", () => {
  test("build and parse are opposites", () => {
    const parts = ["machines", "work-mac", "sessions", "fix-login"];
    expect(buildIdentifier(parts)).toBe("talos:machines:work-mac:sessions:fix-login");
    expect(parseIdentifier(buildIdentifier(parts))).toEqual(parts);
  });

  test("the bare root has no parts", () => {
    expect(buildIdentifier([])).toBe("talos");
    expect(parseIdentifier("talos")).toEqual([]);
  });

  test.each([["omicron:machines"], ["machines:work-mac"], ["talos::work-mac"], ["talos:machines:"], [""]])(
    "%p isn't a Talos identifier",
    (identifier) => {
      expect(parseIdentifier(identifier)).toBeNull();
    },
  );

  test("page paths use the same parts", () => {
    expect(buildPagePath(["machines", "work-mac"])).toBe("/machines/work-mac");
    expect(buildPagePath(["settings"])).toBe("/settings");
  });
});

describe("toIdentifierName", () => {
  test.each([
    ["work-mac", "work-mac"],
    ["Joe's MacBook Pro.local", "joes-macbook-pro"],
    ["Joes-MacBook-Pro.local", "joes-macbook-pro"],
    ["  spark  ", "spark"],
    ["my_project (v2)", "my-project-v2"],
    ["ATLAS", "atlas"],
    ["---", "unnamed"],
    ["", "unnamed"],
    ["日本", "unnamed"],
  ])("%p becomes %p", (text, expected) => {
    expect(toIdentifierName(text)).toBe(expected);
  });

  test("long names are cut without a trailing dash", () => {
    const longName = toIdentifierName(`${"a".repeat(39)} b`);
    expect(longName.length).toBeLessThanOrEqual(40);
    expect(longName.endsWith("-")).toBe(false);
  });
});

describe("pickUniqueName", () => {
  test("a free name is kept", () => {
    expect(pickUniqueName("work-mac", ["spark"])).toBe("work-mac");
  });

  test("a taken name gets the next free number", () => {
    expect(pickUniqueName("work-mac", ["work-mac"])).toBe("work-mac-2");
    expect(pickUniqueName("work-mac", ["work-mac", "work-mac-2"])).toBe("work-mac-3");
    expect(pickUniqueName("work-mac", ["work-mac", "work-mac-3"])).toBe("work-mac-2");
  });
});

test("pickUniqueName keeps a numbered name within the identifier limit", () => {
  const longest = "a".repeat(LIMITS.maxIdentifierLength);
  const numbered = pickUniqueName(longest, [longest]);
  expect(numbered.length).toBe(LIMITS.maxIdentifierLength);
  expect(numbered.endsWith("-2")).toBe(true);
  expect(isIdentifierName(numbered)).toBe(true);
  expect(pickUniqueName(longest, [longest, numbered])).toBe(`${"a".repeat(LIMITS.maxIdentifierLength - 2)}-3`);
});
