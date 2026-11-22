import { randomUUID } from "node:crypto";
import { SIGN_IN_CLOSED, SIGN_IN_RESULT_PARAM, buildPagePath, type CurrentUserResponse, type Logger } from "talos-shared";
import type { ServerConfig } from "./config";
import { COOKIE_NAMES, NO_STORE, SESSION_LIFETIME_MS, SIGN_IN_STATE_LIFETIME_MS } from "./constants";
import { buildGithubSignInUrl, fetchGithubUser, type GithubUser } from "./github";
import type { RequestChecks } from "./request-checks";
import { createSessionToken, type SessionPerson } from "./session";
import type { SettingsTable } from "./settings-table";
import { decideSignIn } from "./sign-in-decision";
import { buildGithubSignInId, type SignInsTable } from "./sign-ins-table";
import { buildCookie, buildExpiredCookie, cookieName, readCookie } from "./utils/cookies";
import { createRandomSecret, isSameSecret } from "./utils/crypto";
import { textResponse } from "./utils/request";

const HOME_PAGE_PATH = buildPagePath(["machines"]);

type AuthTables = { signInsTable: SignInsTable; settingsTable: SettingsTable };

const redirectTo = (location: string, cookies: string[]): Response => {
  const headers = new Headers({ Location: location });
  cookies.forEach((cookie) => headers.append("Set-Cookie", cookie));
  return new Response(null, { status: 302, headers });
};

export const createAuthRoutes = (
  config: ServerConfig,
  checks: RequestChecks,
  { signInsTable, settingsTable }: AuthTables,
  onSignedOut: (personId: string) => void,
  log: Logger,
) => {
  const isSecure = config.publicOrigin.startsWith("https:");
  const clearStateCookie = buildExpiredCookie(cookieName(COOKIE_NAMES.signInState, isSecure), isSecure);

  const signIn = (): Response => {
    const signInState = createRandomSecret();
    const signInUrl = buildGithubSignInUrl(config.githubClientId, config.signInCallbackUrl, signInState);
    const stateCookie = buildCookie(cookieName(COOKIE_NAMES.signInState, isSecure), signInState, {
      maxAgeMs: SIGN_IN_STATE_LIFETIME_MS,
      isSecure,
    });
    log.detail("sign-in: sending a visitor to GitHub");
    return redirectTo(signInUrl, [stateCookie]);
  };

  // Finds the person behind a GitHub account, making a new person if this is
  // their first visit and the switch lets them in. Null means turned away.
  const findOrCreatePerson = async ({ githubId, login: githubLogin }: GithubUser): Promise<(SessionPerson & { signOutCount: number }) | null> => {
    const signInId = buildGithubSignInId(githubId);
    const existingSignIn = await signInsTable.findSignIn(signInId);
    const { allowNewPeople } = await settingsTable.readSettings();
    const decision = decideSignIn({
      existingPersonId: existingSignIn?.personId ?? null,
      isAdmin: checks.isAdminSignIn(signInId),
      allowNewPeople,
    });

    if (decision.outcome === "closed") return null;
    if (decision.outcome === "welcome-back") {
      log.event(`signed in: ${githubLogin}`);
      return { personId: decision.personId, signInId, displayName: githubLogin, signOutCount: existingSignIn?.signOutCount ?? 0 };
    }

    const newSignIn = { signInId, personId: randomUUID(), displayName: githubLogin, linkedAtMs: Date.now() };
    await signInsTable.saveSignIn(newSignIn);
    log.event(`new person signed up: ${githubLogin}`);
    return { personId: newSignIn.personId, signInId, displayName: githubLogin, signOutCount: 0 };
  };

  const signInCallback = async (request: Request): Promise<Response> => {
    const callbackParams = new URL(request.url).searchParams;
    const code = callbackParams.get("code");
    const returnedState = callbackParams.get("state");
    const expectedState = readCookie(request.headers.get("cookie"), cookieName(COOKIE_NAMES.signInState, isSecure));
    // A matching state proves this sign-in started on this server, not on another site.
    const isStateValid = Boolean(returnedState && expectedState && isSameSecret(returnedState, expectedState));
    if (!code || !isStateValid) {
      log.warn("sign-in failed: GitHub sent someone back without a matching sign-in start");
      return textResponse("Sign-in failed. Start again from the page.", 400);
    }

    log.detail("sign-in: GitHub sent someone back, asking GitHub who they are");
    const githubUser = await fetchGithubUser(code, {
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
      redirectUri: config.signInCallbackUrl,
    });
    const person = await findOrCreatePerson(githubUser);
    if (!person) {
      log.event(`turned away new person ${githubUser.login}: new people are switched off`);
      return redirectTo(`${HOME_PAGE_PATH}?${SIGN_IN_RESULT_PARAM}=${SIGN_IN_CLOSED}`, [clearStateCookie]);
    }

    const { signOutCount, ...sessionPerson } = person;
    const issuedAtMs = Date.now();
    const sessionStamp = { issuedAtMs, expiresAtMs: issuedAtMs + SESSION_LIFETIME_MS, signOutCount };
    const sessionToken = createSessionToken(sessionPerson, sessionStamp, config.sessionSecret);
    const sessionCookie = buildCookie(cookieName(COOKIE_NAMES.session, isSecure), sessionToken, { maxAgeMs: SESSION_LIFETIME_MS, isSecure });
    return redirectTo(HOME_PAGE_PATH, [sessionCookie, clearStateCookie]);
  };

  // Ends every session this sign-in has, everywhere, and closes its open pages.
  const signOut = async (request: Request): Promise<Response> => {
    const person = await checks.readTrustedPerson(request);
    if (!person) return textResponse("Not signed in", 401);
    await signInsTable.endSessions(person.signInId);
    onSignedOut(person.personId);
    log.event(`signed out everywhere: ${person.displayName}`);
    const headers = { "Set-Cookie": buildExpiredCookie(cookieName(COOKIE_NAMES.session, isSecure), isSecure) };
    return new Response(null, { status: 204, headers });
  };

  const currentUser = async (request: Request): Promise<Response> => {
    const person = await checks.readSignedInPerson(request);
    if (!person) {
      log.detail("page opened by someone not signed in");
      return textResponse("Not signed in", 401);
    }
    log.detail(`page opened by ${person.displayName}`);
    const isAdmin = checks.isAdminSignIn(person.signInId);
    // Per-person data must never be cached or replayed by a shared cache.
    return Response.json({ displayName: person.displayName, isAdmin } satisfies CurrentUserResponse, NO_STORE);
  };

  return { signIn, signInCallback, signOut, currentUser };
};
