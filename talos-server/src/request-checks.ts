import type { ServerConfig } from "./config";
import { COOKIE_NAMES } from "./constants";
import { readSessionLogin } from "./session";
import { readCookie } from "./utils/cookies";

export const createRequestChecks = (config: ServerConfig) => {
  const readSignedInLogin = (request: Request): string | null => {
    const sessionToken = readCookie(request.headers.get("cookie"), COOKIE_NAMES.session);
    return readSessionLogin(sessionToken, config.sessionSecret, Date.now());
  };

  // Anything that changes something needs a session AND a request sent by
  // Talos's own page, so another site can't use Joe's cookie to act for him.
  const readTrustedLogin = (request: Request): string | null => {
    const isFromOwnPage = request.headers.get("origin") === config.publicOrigin;
    return isFromOwnPage ? readSignedInLogin(request) : null;
  };

  return { readSignedInLogin, readTrustedLogin };
};

export type RequestChecks = ReturnType<typeof createRequestChecks>;
