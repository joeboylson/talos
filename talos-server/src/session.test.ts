import { expect, test } from "bun:test";
import { createSessionToken, readSessionLogin } from "./session";
import { signText } from "./utils/crypto";

const SECRET = "session-secret";
const NOW_MS = 1_000_000;
const LATER_MS = NOW_MS + 60_000;

test("reads back the login from a fresh token", () => {
  const sessionToken = createSessionToken("joeboylson", LATER_MS, SECRET);
  expect(readSessionLogin(sessionToken, SECRET, NOW_MS)).toBe("joeboylson");
});

test("rejects an expired token", () => {
  const sessionToken = createSessionToken("joeboylson", NOW_MS, SECRET);
  expect(readSessionLogin(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token signed with another secret", () => {
  const sessionToken = createSessionToken("joeboylson", LATER_MS, "other-secret");
  expect(readSessionLogin(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token whose login was changed", () => {
  const [, signature] = createSessionToken("joeboylson", LATER_MS, SECRET).split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ login: "someone-else", expiresAtMs: LATER_MS })).toString("base64url");
  expect(readSessionLogin(`${forgedPayload}.${signature}`, SECRET, NOW_MS)).toBeNull();
});

test.each([
  ["no token", null],
  ["empty", ""],
  ["no signature", "abc"],
  ["too many parts", "a.b.c"],
  ["garbage", "!!!.???"],
])("rejects %s", (_label, sessionToken) => {
  expect(readSessionLogin(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a correctly signed payload with the wrong shape", () => {
  const payloadText = Buffer.from(JSON.stringify({ login: 5 })).toString("base64url");
  expect(readSessionLogin(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});
