import { describe, expect, test } from "bun:test";
import { isClaimStillValid } from "../../request-checks";
import { createSessionToken, readSessionClaim } from "../../session";
import { signText } from "../../utils/crypto";

const SECRET = "session-secret";
const NOW_MS = 1_000_000;
const LATER_MS = NOW_MS + 60_000;
const JOE = { personId: "person-1", signInId: "github-id:34290408", displayName: "joeboylson" };
const ISSUED_MS = NOW_MS - 1000;
const until = (expiresAtMs: number) => ({ issuedAtMs: ISSUED_MS, expiresAtMs });

test("reads back the person from a fresh token", () => {
  const sessionToken = createSessionToken(JOE, until(LATER_MS), SECRET);
  expect(readSessionClaim(sessionToken, SECRET, NOW_MS)).toEqual({ ...JOE, issuedAtMs: ISSUED_MS });
});

test("rejects an expired token", () => {
  const sessionToken = createSessionToken(JOE, until(NOW_MS), SECRET);
  expect(readSessionClaim(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token signed with another secret", () => {
  const sessionToken = createSessionToken(JOE, until(LATER_MS), "other-secret");
  expect(readSessionClaim(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a token whose person was changed", () => {
  const [, signature] = createSessionToken(JOE, until(LATER_MS), SECRET).split(".");
  const forgedPerson = { ...JOE, personId: "someone-else", issuedAtMs: ISSUED_MS, expiresAtMs: LATER_MS };
  const forgedPayload = Buffer.from(JSON.stringify(forgedPerson)).toString("base64url");
  expect(readSessionClaim(`${forgedPayload}.${signature}`, SECRET, NOW_MS)).toBeNull();
});

test.each([
  ["no token", null],
  ["empty", ""],
  ["no signature", "abc"],
  ["too many parts", "a.b.c"],
  ["garbage", "!!!.???"],
])("rejects %s", (_label, sessionToken) => {
  expect(readSessionClaim(sessionToken, SECRET, NOW_MS)).toBeNull();
});

test("rejects a correctly signed payload with the wrong shape", () => {
  const payloadText = Buffer.from(JSON.stringify({ personId: 5 })).toString("base64url");
  expect(readSessionClaim(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});

test("an old-style session (login only) no longer works", () => {
  const payloadText = Buffer.from(JSON.stringify({ login: "joeboylson", expiresAtMs: LATER_MS })).toString("base64url");
  expect(readSessionClaim(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});

test("a session made before the new identity, with no issue time, no longer works", () => {
  const payloadText = Buffer.from(JSON.stringify({ ...JOE, expiresAtMs: LATER_MS })).toString("base64url");
  expect(readSessionClaim(`${payloadText}.${signText(payloadText, SECRET)}`, SECRET, NOW_MS)).toBeNull();
});

describe("isClaimStillValid", () => {
  const claim = { ...JOE, issuedAtMs: ISSUED_MS };
  const signIn = { signInId: JOE.signInId, personId: JOE.personId, displayName: "joeboylson", linkedAtMs: 0 };

  test("a session for a sign-in that still exists counts", () => {
    expect(isClaimStillValid(claim, signIn)).toBe(true);
  });

  test("signing out ends sessions made before it, even copied cookies", () => {
    expect(isClaimStillValid(claim, { ...signIn, sessionsEndedAtMs: ISSUED_MS })).toBe(false);
    expect(isClaimStillValid(claim, { ...signIn, sessionsEndedAtMs: ISSUED_MS - 1 })).toBe(true);
  });

  test("a removed sign-in, or one now pointing at someone else, ends the session", () => {
    expect(isClaimStillValid(claim, null)).toBe(false);
    expect(isClaimStillValid(claim, { ...signIn, personId: "someone-else" })).toBe(false);
  });
});
