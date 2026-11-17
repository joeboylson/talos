import { expect, test } from "bun:test";
import { buildCookie, buildExpiredCookie, readCookie } from "../../utils/cookies";
import { hashSecret, isSameSecret } from "../../utils/crypto";
import { readStringField } from "../../utils/request";

test("buildCookie sets the safe flags", () => {
  expect(buildCookie("talos_session", "abc", { maxAgeMs: 90_500, isSecure: false })).toBe(
    "talos_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=90",
  );
  expect(buildCookie("talos_session", "abc", { maxAgeMs: 1000, isSecure: true })).toEndWith("; Secure");
});

test("buildExpiredCookie clears the value", () => {
  expect(buildExpiredCookie("talos_session", false)).toBe("talos_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
});

test("readCookie finds one cookie among several", () => {
  expect(readCookie("a=1; talos_session=abc.def; b=2", "talos_session")).toBe("abc.def");
  expect(readCookie("a=1", "talos_session")).toBeNull();
  expect(readCookie(null, "talos_session")).toBeNull();
});

test("isSameSecret", () => {
  expect(isSameSecret("abc", "abc")).toBe(true);
  expect(isSameSecret("abc", "abd")).toBe(false);
  expect(isSameSecret("abc", "abcd")).toBe(false);
  expect(isSameSecret("", "")).toBe(true);
});

test("hashSecret is stable and doesn't contain the secret", () => {
  expect(hashSecret("secret")).toBe(hashSecret("secret"));
  expect(hashSecret("secret")).not.toContain("secret");
  expect(hashSecret("secret")).not.toBe(hashSecret("secret2"));
});

test.each([
  ["a trimmed value", { name: "  atlas " }, "atlas"],
  ["a missing field", { other: "x" }, null],
  ["a blank value", { name: "   " }, null],
  ["a number", { name: 5 }, null],
  ["not an object", "name", null],
  ["null", null, null],
])("readStringField reads %s", (_label, body, expectedValue) => {
  expect(readStringField(body, "name")).toBe(expectedValue);
});
