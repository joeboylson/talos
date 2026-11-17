import { expect, test } from "bun:test";
import { createLogger, readLogsMode } from "../../logger";

const collectLines = (logsMode: "verbose" | "quiet") => {
  const lines: string[] = [];
  const logger = createLogger(logsMode, (line) => lines.push(line), (line) => lines.push(`warn: ${line}`));
  logger.event("machine connected");
  logger.detail("ping sent");
  logger.warn("unknown key");
  return lines;
};

test("verbose shows events, details and warnings", () => {
  expect(collectLines("verbose")).toEqual(["machine connected", "ping sent", "warn: unknown key"]);
});

test("quiet hides details", () => {
  expect(collectLines("quiet")).toEqual(["machine connected", "warn: unknown key"]);
});

test("readLogsMode", () => {
  expect(readLogsMode("verbose")).toBe("verbose");
  expect(readLogsMode("quiet")).toBe("quiet");
  expect(readLogsMode(undefined)).toBe("quiet");
  expect(readLogsMode("")).toBe("quiet");
  expect(() => readLogsMode("loud")).toThrow('TALOS_LOGS_MODE must be verbose or quiet, not "loud"');
});
