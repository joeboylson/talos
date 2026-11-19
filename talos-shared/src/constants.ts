export const ENV_KEYS = {
  serverUrl: "TALOS_SERVER_URL",
  machineName: "TALOS_MACHINE_NAME",
  logsMode: "TALOS_LOGS_MODE",
  pairOwner: "TALOS_PAIR_OWNER",
} as const;

// The server's data routes live under /api, so they never clash with page
// addresses (/machines, /settings). Sign-in and its callback are pages the
// browser itself goes to, and GitHub knows the callback address.
export const SERVER_ROUTES = {
  pageSocket: "/api/sockets/page",
  machineSocket: "/api/sockets/machine",
  machineCheck: "/api/machine/check",
  pairStart: "/api/pair/start",
  pairPoll: "/api/pair/poll",
  pairApprove: "/api/pair/approve",
  pairCollect: "/api/pair/collect",
  machines: "/api/machines",
  signOut: "/api/auth/logout",
  currentUser: "/api/auth/me",
  settings: "/api/settings",
  signIn: "/auth/login",
  signInCallback: "/auth/callback",
} as const;

// Page addresses, one per kind of thing (see docs/GLOSSARY.md).
export const PAGE_KINDS = ["machines", "folders", "sessions", "settings"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

// GitHub sends a turned-away new person back to the page with ?signIn=closed.
export const SIGN_IN_RESULT_PARAM = "signIn";
export const SIGN_IN_CLOSED = "closed";

export const BEARER_PREFIX = "Bearer ";

// talos answers questions about its own machine here. 127.0.0.1 only, so
// nothing else on the network can reach it.
export const LOCAL_STATUS_HOST = "127.0.0.1";
export const LOCAL_STATUS_PORT = 7071;
export const LOCAL_STATUS_ROUTE = "/status";

export const RECONNECT_DELAY_MS = 2000;

// WebSocket close codes 4000-4999 are free for apps. The server closes a
// socket with one of these to say why it dropped.
export const WS_CLOSE_CODES = {
  machineReplaced: 4000,
  machineRemoved: 4001,
  signedOut: 4002,
  sessionExpired: 4003,
} as const;

// Socket messages carry at most four images (about 12 MB as text), so 16 MB
// covers them with room to spare. The server closes a socket that sends more.
export const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

// Each socket may make the server parse at most this many message bytes per
// window; beyond it, messages are dropped before parsing, so one connection
// can't flood large frames and starve the shared thread for other owners. Well
// above legit traffic (an image message is ~12MB, an entry burst ~13MB/s).
export const SOCKET_INGRESS_WINDOW_MS = 1000;
export const SOCKET_INGRESS_MAX_BYTES = 32 * 1024 * 1024;

// Entry lists go in batches of at most this size, well under the message limit,
// so a session's whole kept history never makes one oversized message.
export const MAX_ENTRIES_BATCH_BYTES = MAX_SOCKET_MESSAGE_BYTES / 4;
