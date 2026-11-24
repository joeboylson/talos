import { expect, test } from "bun:test";
import { changeFromMenu, type LoopQuestions } from "../../loops/loop-menu";
import type { Loop, LoopLimit } from "../../loops/loop";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-24T10:00:00").getTime();
const loop = (changes: Partial<Loop> = {}): Loop => ({ sessionName: "web", message: "check the build", schedule: "0 * * * *", limit: { runs: 24 }, startedAtMs: NOW - DAY_MS, ...changes });

// Answers every limit question with the given limit. Records which questions
// were asked, and the problem the loop would have with that limit.
const answering = (limit: LoopLimit | null) => {
  const asked: string[] = [];
  const problems: (string | null)[] = [];
  const questions: LoopQuestions = {
    askMessage: async () => (asked.push("message"), "check it twice"),
    askSchedule: async () => (asked.push("schedule"), "*/30 * * * *"),
    askLimit: async (_current, problemFor) => {
      asked.push("limit");
      if (limit) problems.push(problemFor(limit));
      return limit;
    },
  };
  return { asked, problems, questions };
};

test("each change asks only its own question", async () => {
  const message = answering(null);
  expect(await changeFromMenu(loop(), "message", NOW, message.questions)).toEqual(loop({ message: "check it twice" }));
  expect(message.asked).toEqual(["message"]);
  const schedule = answering(null);
  expect(await changeFromMenu(loop(), "schedule", NOW, schedule.questions)).toEqual(loop({ schedule: "*/30 * * * *" }));
  expect(schedule.asked).toEqual(["schedule"]);
});

test("a restart keeps its limit, starting from now", async () => {
  const { asked, questions } = answering(null);
  expect(await changeFromMenu(loop(), "restart", NOW, questions)).toEqual(loop({ startedAtMs: NOW }));
  expect(asked).toEqual([]);
});

test("a restart whose end has passed asks for a limit, checked against the new start", async () => {
  const passed = loop({ limit: { untilMs: NOW - 1 } });
  const tooLong = answering({ untilMs: NOW + 8 * DAY_MS });
  expect(await changeFromMenu(passed, "restart", NOW, tooLong.questions)).toEqual(passed && { ...passed, startedAtMs: NOW, limit: { untilMs: NOW + 8 * DAY_MS } });
  expect(tooLong.problems).toEqual(["a loop can last at most 7 days"]);
  const backedOut = answering(null);
  expect(await changeFromMenu(passed, "restart", NOW, backedOut.questions)).toBeNull();
});

test("a new limit is checked against the loop's own start", async () => {
  const { problems, questions } = answering({ untilMs: NOW + 6 * DAY_MS + 1 });
  await changeFromMenu(loop(), "limit", NOW, questions);
  expect(problems).toEqual(["a loop can last at most 7 days"]);
});
