import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SIGN_IN_CLOSED, SIGN_IN_RESULT_PARAM } from "talos-shared";
import { createAuthRoutes } from "../../auth-routes";
import { COOKIE_NAMES, GITHUB_URLS } from "../../constants";
import { createRequestChecks } from "../../request-checks";
import type { SettingsTable } from "../../settings-table";
import { cookieName } from "../../utils/cookies";
import { ADMIN_GITHUB_ID, OTHER_ORIGIN, TEST_ORIGIN, fakeSignInsTable, personIdOf, signInOf, quietLog, testConfig, testRequest } from "../helpers/fakes";

const RETURNING = 2;
const NEWCOMER = 99;
const STATE_COOKIE = cookieName(COOKIE_NAMES.signInState, true);
const SESSION_COOKIE = cookieName(COOKIE_NAMES.session, true);

// GitHub, answering for whoever githubId is.
const fakeGithubAs = (githubId: number) =>
  spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
    if (String(url) === GITHUB_URLS.accessToken) return Response.json({ access_token: "token" });
    if (String(url) === GITHUB_URLS.user) return Response.json({ id: githubId, login: `u${githubId}` });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch);

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const setUp = (allowNewPeople = false) => {
  const signIns = fakeSignInsTable([ADMIN_GITHUB_ID, RETURNING]);
  const settingsTable = { readSettings: async () => ({ allowNewPeople }) } as unknown as SettingsTable;
  const signedOut: string[] = [];
  const checks = createRequestChecks(testConfig, signIns.table);
  const routes = createAuthRoutes(testConfig, checks, { signInsTable: signIns.table, settingsTable }, (personId) => signedOut.push(personId), quietLog);
  return { routes, endedSignIns: signIns.endedSignIns, signedOut };
};

const callback = (returnedState: string, cookieState: string) =>
  new Request(`${TEST_ORIGIN}/auth/callback?code=c&state=${returnedState}`, { headers: { cookie: `${STATE_COOKIE}=${cookieState}` } });

const setCookies = (response: Response) => response.headers.getSetCookie().join("\n");

describe("sign-in callback", () => {
  test("a callback whose state doesn't match the one this server started is turned down, without asking GitHub", async () => {
    const github = fakeGithubAs(RETURNING);
    const response = await setUp().routes.signInCallback(callback("from-another-site", "ours"));
    expect(response.status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });

  test("a new person is turned away while new people are switched off", async () => {
    fakeGithubAs(NEWCOMER);
    const response = await setUp(false).routes.signInCallback(callback("ours", "ours"));
    expect(response.headers.get("location")).toContain(`${SIGN_IN_RESULT_PARAM}=${SIGN_IN_CLOSED}`);
    expect(setCookies(response)).not.toContain(`${SESSION_COOKIE}=`);
  });

  test("someone who's been here before gets a session", async () => {
    fakeGithubAs(RETURNING);
    const response = await setUp(false).routes.signInCallback(callback("ours", "ours"));
    expect(setCookies(response)).toContain(`${SESSION_COOKIE}=`);
  });
});

describe("sign-out", () => {
  test("ends every session of that sign-in and closes the person's pages", async () => {
    const { routes, endedSignIns, signedOut } = setUp();
    expect((await routes.signOut(testRequest({ method: "POST", githubId: RETURNING }))).status).toBe(204);
    expect(endedSignIns).toEqual([signInOf(RETURNING).signInId]);
    expect(signedOut).toEqual([personIdOf(RETURNING)]);
  });

  test("from another site does nothing", async () => {
    const { routes, endedSignIns } = setUp();
    expect((await routes.signOut(testRequest({ method: "POST", githubId: RETURNING, origin: OTHER_ORIGIN }))).status).toBe(401);
    expect(endedSignIns).toEqual([]);
  });
});
