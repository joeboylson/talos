export const ENV_KEYS = {
  serverUrl: "TALOS_SERVER_URL",
  machineName: "TALOS_MACHINE_NAME",
  logsMode: "TALOS_LOGS_MODE",
} as const;

export const SERVER_ROUTES = {
  pageSocket: "/page",
  machineSocket: "/machine",
  machineCheck: "/machine/check",
  pairStart: "/pair/start",
  pairPoll: "/pair/poll",
  pairApprove: "/pair/approve",
  machines: "/machines",
  signIn: "/auth/login",
  signInCallback: "/auth/callback",
  signOut: "/auth/logout",
  currentUser: "/auth/me",
  settings: "/settings",
} as const;

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
