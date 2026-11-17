import { expect, test } from "bun:test";
import { createSessionToken, readSessionPerson } from "../../session";
import { signText } from "../../utils/crypto";

const SECRET = "session-secret";
const NOW_MS = 1_000_000;
const LATER_MS = NOW_MS + 60_000;
const JOE = { personId: "person-1", signInId: "github:joeboylson", displayName: "joeboylson" };

test("reads back the person from a fresh token", () => {
  const sessionToken = createSessionToken(JOE, LATER_MS, SECRET);
  expect(readSessionPerson(sessionToken, SECRET, NOW_MS)).toEqual(JOE);
});

test("rejects an expired token", () => {
  const sessionToken = createSessionToken(JOE, NOW_MS, SECRET);
  expect(readSessionPerson(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token signed with another secret", () => {
  const sessionToken = createSessionToken(JOE, LATER_MS, "other-secret");
  expect(readSessionPerson(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token whose person was changed", () => {
  const [, signature] = createSessionToken(JOE, LATER_MS, SECRET).split(".");
  const forgedPerson = { ...JOE, personId: "someone-else", expiresAtMs: LATER_MS };
  const forgedPayload = Buffer.from(JSON.stringify(forgedPerson)).toString("base64url");
  expect(readSessionPerson(`${forgedPayload}.${signature}`, SECRET, NOW_MS)).toBeNull();
});

test.each([
  ["no token", null],
  ["empty", ""],
  ["no signature", "abc"],
  ["too many parts", "a.b.c"],
  ["garbage", "!!!.???"],
])("rejects %s", (_label, sessionToken) => {
  expect(readSessionPerson(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a correctly signed payload with the wrong shape", () => {
  const payloadText = Buffer.from(JSON.stringify({ personId: 5 })).toString("base64url");
  expect(readSessionPerson(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});

test("an old-style session (login only) no longer works", () => {
  const payloadText = Buffer.from(JSON.stringify({ login: "joeboylson", expiresAtMs: LATER_MS })).toString("base64url");
  expect(readSessionPerson(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});
