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
