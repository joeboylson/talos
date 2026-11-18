import { ENV_KEYS, readLogsMode, requireEnv, type LogsMode } from "talos-shared";
import { DEFAULT_SERVER_PORT, DEFAULT_TABLE_PREFIX, MIN_SESSION_SECRET_LENGTH, SERVER_ENV_KEYS } from "./constants";

export type ServerConfig = {
  serverPort: number;
  publicOrigin: string;
  signInCallbackUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  adminGithubId: number;
  sessionSecret: string;
  tablePrefix: string;
  isUsingEmulator: boolean;
  isProduction: boolean;
  logsMode: LogsMode;
};

type Env = Record<string, string | undefined>;

// GitHub's number for the admin's account (github.com/<login> → api.github.com/users/<login> → "id").
const readAdminGithubId = (text: string): number => {
  const adminGithubId = Number(text);
  if (!Number.isSafeInteger(adminGithubId) || adminGithubId <= 0) {
    throw new Error(`${SERVER_ENV_KEYS.adminGithubId} must be a GitHub account number, like 34290408`);
  }
  return adminGithubId;
};

// A short secret could be guessed, and with it anyone could sign in as anyone.
const readSessionSecret = (text: string): string => {
  if (text.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`${SERVER_ENV_KEYS.sessionSecret} must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  return text;
};

export const readServerConfig = (env: Env, signInCallbackRoute: string): ServerConfig => {
  const publicUrl = new URL(requireEnv(SERVER_ENV_KEYS.publicUrl, env));
  return {
    serverPort: Number(env[SERVER_ENV_KEYS.serverPort] || DEFAULT_SERVER_PORT),
    publicOrigin: publicUrl.origin,
    signInCallbackUrl: new URL(signInCallbackRoute, publicUrl).toString(),
    githubClientId: requireEnv(SERVER_ENV_KEYS.githubClientId, env),
    githubClientSecret: requireEnv(SERVER_ENV_KEYS.githubClientSecret, env),
    adminGithubId: readAdminGithubId(requireEnv(SERVER_ENV_KEYS.adminGithubId, env)),
    sessionSecret: readSessionSecret(requireEnv(SERVER_ENV_KEYS.sessionSecret, env)),
    tablePrefix: env[SERVER_ENV_KEYS.tablePrefix] || DEFAULT_TABLE_PREFIX,
    isUsingEmulator: Boolean(env[SERVER_ENV_KEYS.awsEndpointUrl]),
    // Production serves the page pre-built; anything else rebuilds it on each change.
    isProduction: env.NODE_ENV === "production",
    logsMode: readLogsMode(env[ENV_KEYS.logsMode]),
  };
};
