import { expect, test } from "bun:test";
import { readPageKind } from "../../hooks/use-page-path";

test.each([
  ["/machines", "machines"],
  ["/settings", "settings"],
  ["/settings/", "settings"],
  ["/machines/work-mac", "machines"],
  ["/", "machines"],
  ["/nowhere", "machines"],
] as const)("readPageKind(%p) is %p", (pathname, expected) => {
  expect(readPageKind(pathname)).toBe(expected);
});
