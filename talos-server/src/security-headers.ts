import { LOCAL_STATUS_HOST, LOCAL_STATUS_PORT } from "talos-shared";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

// The page loads nothing from anywhere else. Images are its own, or ones the
// person picked (blob:), so a reply from Claude can't make the browser call
// out to another site through an image. The page may ask talos on this same
// computer about itself. Nothing may put the page in a frame, so another site
// can't trick a signed-in person into clicking inside a hidden copy of it.
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  `connect-src 'self' http://${LOCAL_STATUS_HOST}:${LOCAL_STATUS_PORT}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Sent with every response. HTTPS-only (HSTS) is left off for plain-HTTP
// local development, where it would make the browser refuse localhost.
export const buildSecurityHeaders = (isHttps: boolean): Record<string, string> => ({
  "Content-Security-Policy": CONTENT_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  ...(isHttps ? { "Strict-Transport-Security": `max-age=${ONE_YEAR_SECONDS}` } : {}),
});

// A copy of the response with the headers added: some responses (like
// redirects) have headers that can't be changed in place.
export const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  const securedResponse = new Response(response.body, response);
  Object.entries(headers).forEach(([name, value]) => securedResponse.headers.set(name, value));
  return securedResponse;
};
