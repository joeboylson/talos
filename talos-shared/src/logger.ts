export const LOGS_MODES = ["verbose", "quiet"] as const;
export type LogsMode = (typeof LOGS_MODES)[number];

const DEFAULT_LOGS_MODE: LogsMode = "quiet";

export const readLogsMode = (configuredMode: string | undefined): LogsMode => {
  if (!configuredMode) return DEFAULT_LOGS_MODE;
  const knownMode = LOGS_MODES.find((mode) => mode === configuredMode);
  if (!knownMode) throw new Error(`TALOS_LOGS_MODE must be ${LOGS_MODES.join(" or ")}, not "${configuredMode}"`);
  return knownMode;
};

type WriteLine = (line: string) => void;

// event: things worth seeing every time (sign-ups, pairings, connections).
// detail: the step-by-step trail, shown only in verbose mode.
export const createLogger = (logsMode: LogsMode, writeLine: WriteLine = console.log, writeWarning: WriteLine = console.warn) => ({
  event: (message: string) => writeLine(message),
  detail: (message: string) => {
    if (logsMode === "verbose") writeLine(message);
  },
  warn: (message: string) => writeWarning(message),
});

export type Logger = ReturnType<typeof createLogger>;
