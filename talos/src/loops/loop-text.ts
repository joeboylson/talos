// How a loop reads for a person, shared by `talos sessions <session> loop`
// and attach's loop menu.
import { hasLoopEnded, nextRunMs, sentRunCount, type Loop, type LoopLimit, type LoopRun } from "./loop";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date alone means the end of that day, in local time.
export const parseUntil = (typed: string): number | null => {
  const parsedMs = DATE_ONLY.test(typed) ? new Date(`${typed}T23:59:59`).getTime() : new Date(typed).getTime();
  return Number.isNaN(parsedMs) ? null : parsedMs;
};

// Local time, to the minute: 2026-11-24 14:30.
export const formatTime = (ms: number): string => {
  const date = new Date(ms);
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

export const describeLimit = (limit: LoopLimit): string => ("runs" in limit ? `${limit.runs} runs` : `until ${formatTime(limit.untilMs)}`);

export const describeOutcome = (run: LoopRun): string => {
  if (run.outcome !== "skipped") return run.outcome;
  return run.reason === "busy" ? "skipped: the session was busy" : `skipped ${run.missedRuns}: the machine was off`;
};

const describeNextRun = (loop: Loop, history: readonly LoopRun[], nowMs: number): string => {
  if (hasLoopEnded(loop, history)) return "none: it reached its limit";
  const nextMs = nextRunMs(loop, history, nowMs);
  return nextMs === null ? "none within its limit" : formatTime(nextMs);
};

// Lined up for a person, or tab-separated for a script.
export const loopDetails = (loop: Loop, history: readonly LoopRun[], nowMs: number, isTerminal: boolean): string => {
  const rows = [
    ["message", loop.message],
    ["schedule", loop.schedule],
    ["limit", `${describeLimit(loop.limit)}, ${sentRunCount(loop, history)} sent`],
    ["next run", describeNextRun(loop, history, nowMs)],
  ] as const;
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => (isTerminal ? `${label.padEnd(labelWidth)}${value}` : `${label}\t${value}`)).join("\n");
};

export const loopChangedLine = (loop: Loop, history: readonly LoopRun[], nowMs: number): string =>
  hasLoopEnded(loop, history) ? `${loop.sessionName}'s loop reached its limit` : `looping ${loop.sessionName}: next run ${describeNextRun(loop, history, nowMs)}`;
