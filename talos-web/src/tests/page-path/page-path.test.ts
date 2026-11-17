import { expect, test } from "bun:test";
import { buildLocationPath, readPageLocation } from "../../hooks/use-page-path";

test.each([
  ["/machines", "machines", null, null],
  ["/folders", "folders", null, null],
  ["/sessions", "sessions", null, null],
  ["/settings/", "settings", null, null],
  ["/sessions/atlas/fix-login", "sessions", "atlas", "fix-login"],
  ["/sessions/atlas", "sessions", null, null],
  ["/machines/atlas/fix-login", "machines", null, null],
  ["/", "machines", null, null],
  ["/nowhere", "machines", null, null],
] as const)("readPageLocation(%p)", (pathname, pageKind, machineName, sessionName) => {
  expect(readPageLocation(pathname)).toEqual({ pageKind, machineName, sessionName });
});

test("buildLocationPath is readPageLocation's opposite", () => {
  const sessionLocation = { pageKind: "sessions", machineName: "atlas", sessionName: "fix-login" } as const;
  expect(buildLocationPath(sessionLocation)).toBe("/sessions/atlas/fix-login");
  expect(readPageLocation(buildLocationPath(sessionLocation))).toEqual(sessionLocation);
  expect(buildLocationPath({ pageKind: "folders", machineName: null, sessionName: null })).toBe("/folders");
});
