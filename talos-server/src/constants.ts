export const SERVER_ENV_KEYS = {
  serverPort: "TALOS_SERVER_PORT",
  publicUrl: "TALOS_PUBLIC_URL",
  githubClientId: "TALOS_GITHUB_CLIENT_ID",
  githubClientSecret: "TALOS_GITHUB_CLIENT_SECRET",
  adminGithubLogin: "TALOS_ADMIN_GITHUB_LOGIN",
  sessionSecret: "TALOS_SESSION_SECRET",
  tablePrefix: "TALOS_TABLE_PREFIX",
  awsEndpointUrl: "AWS_ENDPOINT_URL",
} as const;

export const DEFAULT_SERVER_PORT = 7070;
export const DEFAULT_TABLE_PREFIX = "talos-";

// AWS's load balancer calls this to check the server is up.
export const HEALTH_ROUTE = "/health";

// WebSocket close codes 4000–4999 are free for apps to define.
export const CLOSE_CODES = {
  machineReplaced: 4000,
  machineRemoved: 4001,
} as const;

// Per session. Older exchanges stay in the session's own saved conversation.
export const MAX_EXCHANGES_KEPT = 50;

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
