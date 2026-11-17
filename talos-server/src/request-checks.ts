import type { ServerConfig } from "./config";
import { COOKIE_NAMES } from "./constants";
import { readSessionPerson, type SessionPerson } from "./session";
import { buildGithubSignInId } from "./sign-ins-table";
import { readCookie } from "./utils/cookies";

export const createRequestChecks = (config: ServerConfig) => {
  const adminSignInId = buildGithubSignInId(config.adminGithubLogin);

  const readSignedInPerson = (request: Request): SessionPerson | null => {
    const sessionToken = readCookie(request.headers.get("cookie"), COOKIE_NAMES.session);
    return readSessionPerson(sessionToken, config.sessionSecret, Date.now());
  };

  // Anything that changes something needs a session AND a request sent by
  // Talos's own page, so another site can't use someone's cookie to act for them.
  const readTrustedPerson = (request: Request): SessionPerson | null => {
    const isFromOwnPage = request.headers.get("origin") === config.publicOrigin;
    return isFromOwnPage ? readSignedInPerson(request) : null;
  };

  const isAdminSignIn = (signInId: string): boolean => signInId === adminSignInId;

  return { readSignedInPerson, readTrustedPerson, isAdminSignIn };
};

export type RequestChecks = ReturnType<typeof createRequestChecks>;
