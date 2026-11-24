import { describe, expect, test } from "bun:test";
import { dueTimesBetween, parseCron } from "../../loops/cron";

// Local times, because schedules run in local time.
const at = (text: string): number => new Date(text).getTime();

describe("parseCron", () => {
  test("reads every form a field takes", () => {
    const cron = parseCron("*/15 9-17 1,15 * 1-5")!;
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.days]).toEqual([1, 15]);
    expect(cron.months.size).toBe(12);
    expect(cron.isDayOrWeekday).toBe(true);
  });

  test("a start with a step runs to the end of the field; 7 is Sunday", () => {
    expect([...parseCron("50/5 * * * *")!.minutes]).toEqual([50, 55]);
    expect([...parseCron("0 0 * * 7")!.weekdays]).toEqual([0]);
  });

  test("turns down what isn't a schedule", () => {
    ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1- * * * *", "1,,2 * * * *"].forEach((text) =>
      expect(parseCron(text)).toBeNull(),
    );
  });
});

describe("dueTimesBetween", () => {
  test("every time due after the start, up to and including the end", () => {
    const cron = parseCron("*/30 * * * *")!;
    expect(dueTimesBetween(cron, at("2026-11-24T10:00:00"), at("2026-11-24T11:30:00"))).toEqual([at("2026-11-24T10:30:00"), at("2026-11-24T11:00:00"), at("2026-11-24T11:30:00")]);
  });

  test("day and weekday both narrowed: either matches", () => {
    // 2026-11-24 is a Tuesday; the 1st of December is too far.
    const cron = parseCron("0 9 1 * 2")!;
    expect(dueTimesBetween(cron, at("2026-11-23T00:00:00"), at("2026-11-30T00:00:00"))).toEqual([at("2026-11-24T09:00:00")]);
  });

  test("an end before the start has nothing due", () => {
    expect(dueTimesBetween(parseCron("* * * * *")!, at("2026-11-24T10:00:00"), at("2026-11-24T09:00:00"))).toEqual([]);
  });
});

// Runs in New York time, where 01:30 on 2026-11-01 happens twice.
test("a time the clocks going back brings round again is due once", () => {
  const code = `
    import { dueTimesBetween, parseCron } from ${JSON.stringify(new URL("../../loops/cron.ts", import.meta.url).pathname)};
    const due = dueTimesBetween(parseCron("30 1 * * *"), Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-01T08:00:00Z"));
    console.log(JSON.stringify(due.map((ms) => new Date(ms).toISOString())));`;
  const ran = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TZ: "America/New_York" } });
  expect(JSON.parse(ran.stdout.toString())).toEqual(["2026-11-01T05:30:00.000Z"]);
});
