export const SERVER_ENV_KEYS = {
  serverPort: "TALOS_SERVER_PORT",
  publicUrl: "TALOS_PUBLIC_URL",
  githubClientId: "TALOS_GITHUB_CLIENT_ID",
  githubClientSecret: "TALOS_GITHUB_CLIENT_SECRET",
  adminGithubId: "TALOS_ADMIN_GITHUB_ID",
  sessionSecret: "TALOS_SESSION_SECRET",
  tablePrefix: "TALOS_TABLE_PREFIX",
  awsEndpointUrl: "AWS_ENDPOINT_URL",
} as const;

// Sent on per-person JSON so a browser or shared cache never stores or replays it.
export const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

export const DEFAULT_SERVER_PORT = 7070;
export const MIN_SESSION_SECRET_LENGTH = 32;
export const DEFAULT_TABLE_PREFIX = "talos-";

// The page's built files (production only): scripts and styles, named by
// their content, so they can be cached for good.
export const PAGE_ASSETS_ROUTE = "/assets";
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Every HTTP request here is small JSON. Socket messages carry at most four
// images (about 12 MB as text), so 16 MB covers them with room to spare.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

// AWS's load balancer calls this to check the server is up.
export const HEALTH_ROUTE = "/health";

// WebSocket close codes 4000–4999 are free for apps to define.
export const CLOSE_CODES = {
  machineReplaced: 4000,
  machineRemoved: 4001,
  signedOut: 4002,
  sessionExpired: 4003,
} as const;

// AWS's load balancer drops a connection that's quiet for 60 seconds, so the
// server pings every open socket more often than that.
export const KEEP_ALIVE_INTERVAL_MS = 30 * 1000;

// A ping not answered by then is forgotten.
export const PING_ANSWER_WAIT_MS = 60 * 1000;

export const NO_MACHINES_MESSAGE = "No machines connected";

export const COOKIE_NAMES = {
  session: "talos_session",
  signInState: "talos_sign_in_state",
} as const;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const SESSION_LIFETIME_MS = 7 * DAY_MS;
export const SIGN_IN_STATE_LIFETIME_MS = 10 * MINUTE_MS;
export const PAIRING_LIFETIME_MS = 10 * MINUTE_MS;

// Starting a pairing needs no sign-in, so cap how many can wait at once.
export const MAX_WAITING_PAIRINGS = 100;

// How often one address may start a pairing, and one person enter a code.
// Plenty for real use; too few to fill the queue or guess codes.
export const PAIR_START_LIMIT = { windowMs: 10 * MINUTE_MS, maxAttempts: 10 };
export const PAIR_APPROVE_LIMIT = { windowMs: 10 * MINUTE_MS, maxAttempts: 10 };
export const MAX_MACHINES_PER_PERSON = 20;

export const GITHUB_URLS = {
  authorize: "https://github.com/login/oauth/authorize",
  accessToken: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
} as const;

// GitHub's API turns away requests without a User-Agent.
export const GITHUB_USER_AGENT = "talos-server";

// No 0/O or 1/I, so a code read off a screen can't be mistyped.
export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USER_CODE_GROUP_LENGTH = 4;

export const RANDOM_SECRET_BYTES = 32;
