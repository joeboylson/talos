import type { CurrentUserResponse } from "talos-shared";
import type { ServerConfig } from "./config";
import { COOKIE_NAMES, SESSION_LIFETIME_MS, SIGN_IN_STATE_LIFETIME_MS } from "./constants";
import { buildGithubSignInUrl, fetchGithubLogin } from "./github";
import type { RequestChecks } from "./request-checks";
import { createSessionToken } from "./session";
import { buildCookie, buildExpiredCookie, readCookie } from "./utils/cookies";
import { createRandomSecret, isSameSecret } from "./utils/crypto";
import { textResponse } from "./utils/request";

export const createAuthRoutes = (config: ServerConfig, checks: RequestChecks) => {
  const isSecure = config.publicOrigin.startsWith("https:");

  const signIn = (): Response => {
    const signInState = createRandomSecret();
    const signInUrl = buildGithubSignInUrl(config.githubClientId, config.signInCallbackUrl, signInState);
    const stateCookie = buildCookie(COOKIE_NAMES.signInState, signInState, {
      maxAgeMs: SIGN_IN_STATE_LIFETIME_MS,
      isSecure,
    });
    return new Response(null, { status: 302, headers: { Location: signInUrl, "Set-Cookie": stateCookie } });
  };

  const signInCallback = async (request: Request): Promise<Response> => {
    const callbackParams = new URL(request.url).searchParams;
    const code = callbackParams.get("code");
    const returnedState = callbackParams.get("state");
    const expectedState = readCookie(request.headers.get("cookie"), COOKIE_NAMES.signInState);
    // A matching state proves this sign-in started on this server, not on another site.
    const isStateValid = Boolean(returnedState && expectedState && isSameSecret(returnedState, expectedState));
    if (!code || !isStateValid) return textResponse("Sign-in failed. Start again from the page.", 400);

    const login = await fetchGithubLogin(code, {
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
      redirectUri: config.signInCallbackUrl,
    });
    const isAllowedLogin = login.toLowerCase() === config.allowedGithubLogin.toLowerCase();
    if (!isAllowedLogin) {
      console.warn(`turned away GitHub user ${login}`);
      return textResponse(`${login} isn't allowed to use Talos.`, 403);
    }

    const sessionToken = createSessionToken(login, Date.now() + SESSION_LIFETIME_MS, config.sessionSecret);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", buildCookie(COOKIE_NAMES.session, sessionToken, { maxAgeMs: SESSION_LIFETIME_MS, isSecure }));
    headers.append("Set-Cookie", buildExpiredCookie(COOKIE_NAMES.signInState, isSecure));
    return new Response(null, { status: 302, headers });
  };

  const signOut = (request: Request): Response => {
    if (!checks.readTrustedLogin(request)) return textResponse("Not signed in", 401);
    const headers = { "Set-Cookie": buildExpiredCookie(COOKIE_NAMES.session, isSecure) };
    return new Response(null, { status: 204, headers });
  };

  const currentUser = (request: Request): Response => {
    const login = checks.readSignedInLogin(request);
    if (!login) return textResponse("Not signed in", 401);
    return Response.json({ login } satisfies CurrentUserResponse);
  };

  return { signIn, signInCallback, signOut, currentUser };
};
