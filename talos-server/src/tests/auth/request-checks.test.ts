import { expect, test } from "bun:test";
import { createRequestChecks } from "../../request-checks";
import { ADMIN_GITHUB_ID, OTHER_ORIGIN, fakeSignInsTable, personIdOf, sessionCookieFor, signInOf, testConfig, testRequest } from "../helpers/fakes";

const JOE = 2;
const checksWith = (signOutCounts?: Map<string, number>) => createRequestChecks(testConfig, fakeSignInsTable([ADMIN_GITHUB_ID, JOE], signOutCounts).table);

test("a signed-in request from Talos's own page is trusted", async () => {
  expect((await checksWith().readTrustedPerson(testRequest({ githubId: JOE })))?.personId).toBe(personIdOf(JOE));
});

test("the same cookie sent from another site isn't trusted, though it still reads as signed in", async () => {
  const fromOtherSite = testRequest({ githubId: JOE, origin: OTHER_ORIGIN });
  expect(await checksWith().readTrustedPerson(fromOtherSite)).toBeNull();
  expect((await checksWith().readSignedInPerson(fromOtherSite))?.personId).toBe(personIdOf(JOE));
});

test("only the admin's sign-in is the admin", () => {
  expect(checksWith().isAdminSignIn(signInOf(ADMIN_GITHUB_ID).signInId)).toBe(true);
  expect(checksWith().isAdminSignIn(signInOf(JOE).signInId)).toBe(false);
});

test("a cookie made before its sign-in signed out no longer works, and one made after does", async () => {
  const checks = checksWith(new Map([[signInOf(JOE).signInId, 1]]));
  const before = new Request("https://talos.test", { headers: { cookie: sessionCookieFor(JOE, 0) } });
  const after = new Request("https://talos.test", { headers: { cookie: sessionCookieFor(JOE, 1) } });
  expect(await checks.readSignedInPerson(before)).toBeNull();
  expect(await checks.readSignedInPerson(after)).not.toBeNull();
});
