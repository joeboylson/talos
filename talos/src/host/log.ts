import { ENV_KEYS, createLogger, readLogsMode } from "talos-shared";

export const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));
