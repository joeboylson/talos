export const ENV_KEYS = {
  machineKey: "TALOS_MACHINE_KEY",
  serverPort: "TALOS_SERVER_PORT",
  serverUrl: "TALOS_SERVER_URL",
  machineName: "TALOS_MACHINE_NAME",
} as const;

export const DEFAULT_SERVER_PORT = 7070;

export const SERVER_ROUTES = {
  page: "/page",
  machine: "/machine",
} as const;

export const MACHINE_NAME_QUERY_PARAM = "name";
export const BEARER_PREFIX = "Bearer ";

// talos answers questions about its own machine here. 127.0.0.1 only, so
// nothing else on the network can reach it.
export const LOCAL_STATUS_HOST = "127.0.0.1";
export const LOCAL_STATUS_PORT = 7071;
export const LOCAL_STATUS_ROUTE = "/status";

export const RECONNECT_DELAY_MS = 2000;
