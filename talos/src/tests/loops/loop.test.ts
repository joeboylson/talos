import { describe, expect, test } from "bun:test";
import { LOOP_LIMITS } from "../../loops/constants";
import { checkLoop, hasLoopEnded, loopProblem, nextRunMs, sentRunCount, type Loop, type LoopRun } from "../../loops/loop";

const at = (text: string): number => new Date(text).getTime();
const START = at("2026-11-24T10:00:30");
const DAY_MS = 24 * 60 * 60 * 1000;
const loop = (changes: Partial<Loop> = {}): Loop => ({ sessionName: "web", message: { text: "check the build" }, schedule: "*/10 * * * *", limit: { runs: 3 }, startedAtMs: START, ...changes });
const sent = (atMs: number): LoopRun => ({ atMs, outcome: "sent" });

describe("loopProblem", () => {
  test("a good loop has none", () => {
    expect(loopProblem(loop())).toBeNull();
    expect(loopProblem(loop({ limit: { untilMs: START + 7 * DAY_MS } }))).toBeNull();
  });

  test("every limit is checked", () => {
    expect(loopProblem(loop({ message: { text: "  " } }))).toContain("empty");
    expect(loopProblem(loop({ message: { file: "notes/prompt.md" } }))).toContain("needs its full path");
    expect(loopProblem(loop({ message: { file: "/home/joe/prompt.md" } }))).toBeNull();
    expect(loopProblem(loop({ schedule: "every hour" }))).toContain("isn't a cron schedule");
    expect(loopProblem(loop({ limit: { runs: 0 } }))).toContain("1 to 999");
    expect(loopProblem(loop({ limit: { runs: LOOP_LIMITS.maxRuns + 1 } }))).toContain("1 to 999");
    expect(loopProblem(loop({ limit: { runs: 1.5 } }))).toContain("1 to 999");
    expect(loopProblem(loop({ limit: { untilMs: START - 1 } }))).toContain("already past");
    expect(loopProblem(loop({ limit: { untilMs: START + 7 * DAY_MS + 1 } }))).toContain("at most 7 days");
  });
});

describe("checkLoop", () => {
  const check = (changes: Partial<Parameters<typeof checkLoop>[0]> = {}) =>
    checkLoop({ loop: loop(), history: [], lastCheckMs: at("2026-11-24T10:09:55"), nowMs: at("2026-11-24T10:10:05"), skipReason: null, ...changes });

  test("nothing due, nothing added", () => {
    expect(check({ lastCheckMs: at("2026-11-24T10:01:00"), nowMs: at("2026-11-24T10:01:10") })).toEqual([]);
  });

  test("a run due now is sent to a free session", () => {
    expect(check()).toEqual([sent(at("2026-11-24T10:10:05"))]);
  });

  test("a busy session's run is skipped", () => {
    expect(check({ skipReason: "busy" })).toEqual([{ atMs: at("2026-11-24T10:10:05"), outcome: "skipped", reason: "busy" }]);
  });

  test("a run whose file can't be read is skipped, and doesn't count toward the limit", () => {
    const runs = check({ skipReason: "unreadable-file" });
    expect(runs).toEqual([{ atMs: at("2026-11-24T10:10:05"), outcome: "skipped", reason: "unreadable-file" }]);
    expect(sentRunCount(loop(), runs)).toBe(0);
  });

  test("runs due while the machine was off are skipped, counted once; the one due now still runs", () => {
    const runs = check({ lastCheckMs: at("2026-11-24T10:05:00"), nowMs: at("2026-11-24T10:40:20") });
    expect(runs).toEqual([
      { atMs: at("2026-11-24T10:40:20"), outcome: "skipped", reason: "machine-off", missedRuns: 3 },
      sent(at("2026-11-24T10:40:20")),
    ]);
  });

  test("nothing before the loop started counts", () => {
    expect(check({ lastCheckMs: at("2026-11-24T09:00:00"), nowMs: at("2026-11-24T10:00:40") })).toEqual([]);
  });

  test("the last run allowed ends the loop", () => {
    const history = [sent(at("2026-11-24T10:10:00")), sent(at("2026-11-24T10:20:00"))];
    const runs = check({ history, lastCheckMs: at("2026-11-24T10:29:55"), nowMs: at("2026-11-24T10:30:05") });
    expect(runs.map((run) => run.outcome)).toEqual(["sent", "ended"]);
    expect(checkLoop({ loop: loop(), history: [...history, ...runs], lastCheckMs: at("2026-11-24T10:39:55"), nowMs: at("2026-11-24T10:40:05"), skipReason: null })).toEqual([]);
  });

  test("an end time ends the loop once it's passed, sending nothing after it", () => {
    const untilLoop = loop({ limit: { untilMs: at("2026-11-24T10:15:00") } });
    expect(check({ loop: untilLoop, lastCheckMs: at("2026-11-24T10:19:55"), nowMs: at("2026-11-24T10:20:05") })).toEqual([{ atMs: at("2026-11-24T10:20:05"), outcome: "ended" }]);
  });

  test("a restart counts from its new start", () => {
    const history = [sent(at("2026-11-24T10:10:00")), sent(at("2026-11-24T10:20:00")), sent(at("2026-11-24T10:30:00")), { atMs: at("2026-11-24T10:30:00"), outcome: "ended" as const }];
    const restarted = loop({ startedAtMs: at("2026-11-24T11:00:00") });
    expect(hasLoopEnded(loop(), history)).toBe(true);
    expect(hasLoopEnded(restarted, history)).toBe(false);
    expect(sentRunCount(restarted, history)).toBe(0);
    expect(checkLoop({ loop: restarted, history, lastCheckMs: at("2026-11-24T11:09:55"), nowMs: at("2026-11-24T11:10:05"), skipReason: null })).toEqual([sent(at("2026-11-24T11:10:05"))]);
  });
});

describe("nextRunMs", () => {
  test("the next time due, within the limit", () => {
    expect(nextRunMs(loop(), [], at("2026-11-24T10:01:00"))).toBe(at("2026-11-24T10:10:00"));
    expect(nextRunMs(loop({ limit: { untilMs: at("2026-11-24T10:05:00") } }), [], at("2026-11-24T10:01:00"))).toBeNull();
  });

  test("an ended loop has none", () => {
    expect(nextRunMs(loop(), [{ atMs: START + 1, outcome: "ended" }], at("2026-11-24T10:01:00"))).toBeNull();
  });
});
