// What each check of a loop decides: send a run, skip one, or end the loop at
// its limit. No side effects here; loop-runner.ts sends and saves.
import { dueTimesBetween, parseCron } from "./cron";
import { LOOP_LIMITS } from "./constants";

export type LoopLimit = { runs: number } | { untilMs: number };
export type Loop = { sessionName: string; message: string; schedule: string; limit: LoopLimit; startedAtMs: number };

// busy: the session was still working, on the last run or anything else.
// machine-off: the run came due while the machine was asleep or off.
export type LoopRun =
  | { atMs: number; outcome: "sent" }
  | { atMs: number; outcome: "skipped"; reason: "busy" }
  | { atMs: number; outcome: "skipped"; reason: "machine-off"; missedRuns: number }
  | { atMs: number; outcome: "ended" };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOP_MS = LOOP_LIMITS.maxDays * DAY_MS;

export const loopProblem = (loop: Loop): string | null => {
  if (!loop.message.trim()) return "the loop's message is empty";
  if (!parseCron(loop.schedule)) return `"${loop.schedule}" isn't a cron schedule (like "*/30 * * * *")`;
  if ("runs" in loop.limit) {
    const { runs } = loop.limit;
    const isRunsAllowed = Number.isInteger(runs) && runs >= 1 && runs <= LOOP_LIMITS.maxRuns;
    return isRunsAllowed ? null : `a loop's runs must be 1 to ${LOOP_LIMITS.maxRuns}`;
  }
  const lastsMs = loop.limit.untilMs - loop.startedAtMs;
  if (lastsMs <= 0) return "the loop's end is already past";
  return lastsMs > MAX_LOOP_MS ? `a loop can last at most ${LOOP_LIMITS.maxDays} days` : null;
};

// A restart moves startedAtMs, so only the runs after it count.
const runsSinceStart = (loop: Loop, history: readonly LoopRun[]): LoopRun[] => history.filter((run) => run.atMs >= loop.startedAtMs);

export const sentRunCount = (loop: Loop, history: readonly LoopRun[]): number =>
  runsSinceStart(loop, history).filter((run) => run.outcome === "sent").length;

export const hasLoopEnded = (loop: Loop, history: readonly LoopRun[]): boolean => runsSinceStart(loop, history).some((run) => run.outcome === "ended");

// A loop limited by runs has no end time, so a check looks at most 7 days ahead.
const lastAllowedMs = (loop: Loop, nowMs: number): number => ("untilMs" in loop.limit ? loop.limit.untilMs : nowMs + MAX_LOOP_MS);

export const nextRunMs = (loop: Loop, history: readonly LoopRun[], nowMs: number): number | null => {
  const cron = parseCron(loop.schedule);
  if (!cron || hasLoopEnded(loop, history)) return null;
  return dueTimesBetween(cron, nowMs, lastAllowedMs(loop, nowMs))[0] ?? null;
};

export type LoopCheck = { loop: Loop; history: readonly LoopRun[]; lastCheckMs: number; nowMs: number; isSessionFree: boolean };

// Returns the runs one check adds to the history. Checks come every few
// seconds, so a run due more than LOOP_LIMITS.lateMs ago means the machine was
// asleep or off.
export const checkLoop = ({ loop, history, lastCheckMs, nowMs, isSessionFree }: LoopCheck): LoopRun[] => {
  const cron = parseCron(loop.schedule);
  if (!cron || hasLoopEnded(loop, history)) return [];
  const windowStartMs = Math.max(lastCheckMs, loop.startedAtMs);
  const windowEndMs = Math.min(nowMs, lastAllowedMs(loop, nowMs));
  const dueTimes = dueTimesBetween(cron, windowStartMs, windowEndMs);
  const missedTimes = dueTimes.filter((dueMs) => nowMs - dueMs > LOOP_LIMITS.lateMs);
  const hasRunDueNow = dueTimes.length > missedTimes.length;
  const missed: LoopRun[] = missedTimes.length > 0 ? [{ atMs: nowMs, outcome: "skipped", reason: "machine-off", missedRuns: missedTimes.length }] : [];
  const thisRun: LoopRun[] = !hasRunDueNow ? [] : isSessionFree ? [{ atMs: nowMs, outcome: "sent" }] : [{ atMs: nowMs, outcome: "skipped", reason: "busy" }];
  const added = [...missed, ...thisRun];
  const isPastEnd = "untilMs" in loop.limit && nowMs >= loop.limit.untilMs;
  const isOutOfRuns = "runs" in loop.limit && sentRunCount(loop, [...history, ...added]) >= loop.limit.runs;
  return isPastEnd || isOutOfRuns ? [...added, { atMs: nowMs, outcome: "ended" }] : added;
};
