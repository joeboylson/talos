import type { ServerConfig } from "./config";
import { COOKIE_NAMES } from "./constants";
import { readSessionClaim, type SessionClaim, type SessionPerson } from "./session";

// A signed-in person plus when their session expires, so a live page socket
// can be closed once the session would no longer be accepted.
export type SignedInPerson = SessionPerson & { expiresAtMs: number };
import { buildGithubSignInId, type SignInRecord, type SignInsTable } from "./sign-ins-table";
import { cookieName, readCookie } from "./utils/cookies";

// A signed cookie alone isn't enough: its sign-in must still exist, belong to
// the same person, and not have been signed out since the cookie was made.
export const isClaimStillValid = (claim: SessionClaim, signIn: SignInRecord | null): boolean =>
  signIn !== null && signIn.personId === claim.personId && claim.signOutCount === (signIn.signOutCount ?? 0);

export const createRequestChecks = (config: ServerConfig, signInsTable: SignInsTable) => {
  const adminSignInId = buildGithubSignInId(config.adminGithubId);

  const readSignedInPerson = async (request: Request): Promise<SignedInPerson | null> => {
    const isSecure = config.publicOrigin.startsWith("https:");
    const sessionToken = readCookie(request.headers.get("cookie"), cookieName(COOKIE_NAMES.session, isSecure));
    const claim = readSessionClaim(sessionToken, config.sessionSecret, Date.now());
    if (!claim) return null;
    if (!isClaimStillValid(claim, await signInsTable.findSignIn(claim.signInId))) return null;
    const { personId, signInId, displayName, expiresAtMs } = claim;
    return { personId, signInId, displayName, expiresAtMs };
  };

  // Anything that changes something needs a session AND a request sent by
  // Talos's own page, so another site can't use someone's cookie to act for them.
  const readTrustedPerson = async (request: Request): Promise<SignedInPerson | null> => {
    const isFromOwnPage = request.headers.get("origin") === config.publicOrigin;
    return isFromOwnPage ? readSignedInPerson(request) : null;
  };

  const isAdminSignIn = (signInId: string): boolean => signInId === adminSignInId;

  return { readSignedInPerson, readTrustedPerson, isAdminSignIn };
};

export type RequestChecks = ReturnType<typeof createRequestChecks>;
