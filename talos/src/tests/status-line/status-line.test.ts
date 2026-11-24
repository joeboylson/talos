import { expect, test } from "bun:test";
import { createStatusLine } from "../../status-line";
import { retryWaitMs } from "../../connect";
import { PAIRING_BUSY_WAIT_MS, RETRY_LONGEST_WAIT_MS } from "../../constants";
import { RECONNECT_DELAY_MS } from "talos-shared";

const CLEAR_LINE = "\r\x1b[2K";
const record = (isTerminal: boolean) => {
  const written: string[] = [];
  return { written, statusLine: createStatusLine((text) => written.push(text), isTerminal) };
};

test("in a terminal, each retry replaces the last on one line, and the line ends before anything else", () => {
  const { written, statusLine } = record(true);
  statusLine.show("can't reach it (1 tries)");
  statusLine.show("can't reach it (2 tries)");
  statusLine.end();
  statusLine.end();
  expect(written).toEqual([`${CLEAR_LINE}can't reach it (1 tries)`, `${CLEAR_LINE}can't reach it (2 tries)`, "\n"]);
});

test("in a log, a text that repeats is written once, until something else is", () => {
  const { written, statusLine } = record(false);
  statusLine.show("too many pairing requests");
  statusLine.show("too many pairing requests");
  statusLine.end();
  statusLine.show("too many pairing requests");
  expect(written).toEqual(["too many pairing requests\n", "too many pairing requests\n"]);
});

test("a retry waits twice as long each time up to the longest, and a minute when pairing is busy", () => {
  const failure = new Error("connection refused");
  expect([1, 2, 3, 10].map((attempt) => retryWaitMs(attempt, failure))).toEqual([
    RECONNECT_DELAY_MS,
    RECONNECT_DELAY_MS * 2,
    RECONNECT_DELAY_MS * 4,
    RETRY_LONGEST_WAIT_MS,
  ]);
  const busy = new Error("/api/pair/start failed: 429 Too many pairing requests; wait a few minutes");
  expect(retryWaitMs(1, busy)).toBe(PAIRING_BUSY_WAIT_MS);
});
