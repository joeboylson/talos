import { ENV_KEYS, readLogsMode, requireEnv, type LogsMode } from "talos-shared";
import { DEFAULT_SERVER_PORT, DEFAULT_TABLE_PREFIX, SERVER_ENV_KEYS } from "./constants";

export type ServerConfig = {
  serverPort: number;
  publicOrigin: string;
  signInCallbackUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  adminGithubLogin: string;
  sessionSecret: string;
  tablePrefix: string;
  isUsingEmulator: boolean;
  isProduction: boolean;
  logsMode: LogsMode;
};

type Env = Record<string, string | undefined>;

export const readServerConfig = (env: Env, signInCallbackRoute: string): ServerConfig => {
  const publicUrl = new URL(requireEnv(SERVER_ENV_KEYS.publicUrl, env));
  return {
    serverPort: Number(env[SERVER_ENV_KEYS.serverPort] || DEFAULT_SERVER_PORT),
    publicOrigin: publicUrl.origin,
    signInCallbackUrl: new URL(signInCallbackRoute, publicUrl).toString(),
    githubClientId: requireEnv(SERVER_ENV_KEYS.githubClientId, env),
    githubClientSecret: requireEnv(SERVER_ENV_KEYS.githubClientSecret, env),
    adminGithubLogin: requireEnv(SERVER_ENV_KEYS.adminGithubLogin, env),
    sessionSecret: requireEnv(SERVER_ENV_KEYS.sessionSecret, env),
    tablePrefix: env[SERVER_ENV_KEYS.tablePrefix] || DEFAULT_TABLE_PREFIX,
    isUsingEmulator: Boolean(env[SERVER_ENV_KEYS.awsEndpointUrl]),
    // Production serves the page pre-built; anything else rebuilds it on each change.
    isProduction: env.NODE_ENV === "production",
    logsMode: readLogsMode(env[ENV_KEYS.logsMode]),
  };
};
