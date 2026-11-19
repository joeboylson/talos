type CookieOptions = { maxAgeMs: number; isSecure: boolean };

// HttpOnly keeps page scripts from reading it; SameSite=Lax keeps other sites
// from sending it along with their requests.
export const buildCookie = (name: string, value: string, { maxAgeMs, isSecure }: CookieOptions): string => {
  const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
  const secureFlag = isSecure ? ["Secure"] : [];
  return [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, ...secureFlag].join("; ");
};

export const buildExpiredCookie = (name: string, isSecure: boolean): string =>
  buildCookie(name, "", { maxAgeMs: 0, isSecure });

export const readCookie = (cookieHeader: string | null, name: string): string | null =>
  new Bun.CookieMap(cookieHeader ?? "").get(name);

// On a shared registrable domain (talos runs on *.on.aws, which isn't a public
// suffix, so every tenant is "same site"), a sibling site could set a
// Domain-scoped cookie that overrides ours — "cookie tossing", which allows
// session fixation. The __Host- prefix makes the browser refuse any cookie of
// that name carrying a Domain, so only we can set it, host-only. It requires
// Secure + Path=/ (buildCookie sets both), so it's used only for a Secure cookie;
// plain-http local dev keeps the bare name.
export const cookieName = (baseName: string, isSecure: boolean): string => (isSecure ? `__Host-${baseName}` : baseName);
