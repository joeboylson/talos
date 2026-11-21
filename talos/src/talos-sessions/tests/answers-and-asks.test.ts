import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions, mergeSessionEntries, type RunnerEvent, type SessionEntry, type SessionSummary } from "../index";

// Answers and asks meeting in one session, on the real session runner with the
// fake Claude (tests/fake/). Each thing talos types must start a turn of its
// own: the fake Claude saves a "BUSY" line for text typed into a running turn,
// and a "DENIED" line for a tool talos turned down.
const home = mkdtempSync(join(tmpdir(), "talos-answers-asks-"));
const calls = connectToSessions({ home, runnerScript: new URL("./fake/fake-runner.ts", import.meta.url).pathname });

const entries: Record<string, SessionEntry[]> = {};
const latest: Record<string, SessionSummary> = {};
const onEvent = (event: RunnerEvent) => {
  if (event.type === "sessions") event.sessions.forEach((session) => (latest[session.sessionName] = session));
  if (event.type === "session-entries") entries[event.sessionName] = mergeSessionEntries(entries[event.sessionName] ?? [], event.entries, 500);
};

const waitUntil = async (isDone: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!isDone()) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

const texts = (name: string) => (entries[name] ?? []).flatMap((entry) => (entry.kind === "prompt" || entry.kind === "text" ? [entry.text] : []));
const prompts = (name: string) => (entries[name] ?? []).flatMap((entry) => (entry.kind === "prompt" ? [entry.text] : []));
const isSettled = (name: string) => latest[name]?.state !== "working";

const startWithQuestions = async (name: string, message: string, count: number) => {
  const work = join(home, name);
  mkdirSync(work);
  expect(await calls.start(name, name, work)).toEqual({ ok: true });
  await waitUntil(() => latest[name]?.state === "idle", "the session to be ready");
  expect(await calls.send(name, message)).toEqual({ ok: true });
  await waitUntil(() => latest[name]?.openOutputs.length === count && latest[name]?.state === "needs-you", "the questions");
  return latest[name]!.openOutputs;
};

beforeAll(async () => {
  await calls.ensureRunning();
  calls.follow(onEvent);
});
afterAll(async () => {
  await calls.stopRunner().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

test(
  "two answers clicked together go in one turn after the other",
  async () => {
    const [first, second] = await startWithQuestions("two", "go2", 2);
    expect(await Promise.all([calls.answer("two", first!.id, 0), calls.answer("two", second!.id, 1)])).toEqual([{ ok: true }, { ok: true }]);
    await waitUntil(() => prompts("two").length === 3 && latest.two?.openOutputs.length === 0 && isSettled("two"), "both answers");
    expect(prompts("two")).toEqual(["go2", `Answer to ${first!.id}: A`, `Answer to ${second!.id}: D`]);
    expect(texts("two").filter((text) => /^(BUSY|DENIED)/.test(text))).toEqual([]);
  },
  30_000,
);

test(
  "an answer clicked just after a status ask waits for the asked-for turn to end",
  async () => {
    const [question] = await startWithQuestions("ask-then-answer", "go", 1);
    expect(await calls.ask("ask-then-answer", "status")).toEqual({ ok: true });
    expect(await calls.answer("ask-then-answer", question!.id, 1)).toEqual({ ok: true });
    await waitUntil(() => prompts("ask-then-answer").length === 3 && isSettled("ask-then-answer"), "the request and the answer");
    expect(prompts("ask-then-answer")).toEqual(["go", "please send status", `Answer to ${question!.id}: B`]);
    expect(latest["ask-then-answer"]?.asks.status).toMatchObject({ state: "answered", latest: { text: "all good" } });
    expect(texts("ask-then-answer").filter((text) => /^(BUSY|DENIED)/.test(text))).toEqual([]);
  },
  30_000,
);

test(
  "a status ask doesn't close a question that's waiting for an answer",
  async () => {
    const [question] = await startWithQuestions("ask-only", "go", 1);
    expect(await calls.ask("ask-only", "status")).toEqual({ ok: true });
    await waitUntil(() => latest["ask-only"]?.asks.status?.state === "answered" && isSettled("ask-only"), "the status");
    expect(latest["ask-only"]?.openOutputs.map(({ id }) => id)).toEqual([question!.id]);
    expect(await calls.answer("ask-only", question!.id, 0)).toEqual({ ok: true });
  },
  30_000,
);

// talos sets the session working just before its Esc, so waiting for that lands
// in its pause before the paste.
const inTalosPause = async (name: string) => waitUntil(() => latest[name]?.state === "working", "talos to start typing", 10_000);

test(
  "keys typed while talos types an answer aren't glued into it",
  async () => {
    const [question] = await startWithQuestions("keys-glue", "go", 1);
    expect(await calls.answer("keys-glue", question!.id, 0)).toEqual({ ok: true });
    await inTalosPause("keys-glue");
    expect(await calls.keys("keys-glue", "hel")).toEqual({ ok: true });
    await waitUntil(() => prompts("keys-glue").some((text) => text.includes("Answer to")), "the answer");
    expect(prompts("keys-glue").filter((text) => text.includes("Answer to"))).toEqual([`Answer to ${question!.id}: A`]);
  },
  30_000,
);

test(
  "a message sent while talos types an answer waits for it, so the answer has its own turn",
  async () => {
    const [question] = await startWithQuestions("send-during", "go", 1);
    expect(await calls.answer("send-during", question!.id, 0)).toEqual({ ok: true });
    await inTalosPause("send-during");
    expect(await calls.send("send-during", "from the page")).toEqual({ ok: true });
    await waitUntil(() => prompts("send-during").includes("from the page"), "the message");
    expect(texts("send-during").filter((text) => text.startsWith("BUSY Answer to"))).toEqual([]);
  },
  30_000,
);

// A question, then a permission prompt in the same turn: the answer is held.
const atPrompt = async (name: string) => {
  const work = join(home, name);
  mkdirSync(work);
  expect(await calls.start(name, name, work)).toEqual({ ok: true });
  await waitUntil(() => latest[name]?.state === "idle", "the session to be ready");
  expect(await calls.send(name, "go-prompt")).toEqual({ ok: true });
  await waitUntil(() => latest[name]?.openOutputs.length === 1 && latest[name]?.state === "needs-you", "the question and the prompt");
  return latest[name]!.openOutputs[0]!;
};

test(
  "Esc refusing a permission prompt ends the turn, so the answer held during it goes in",
  async () => {
    const question = await atPrompt("refuse");
    expect(await calls.answer("refuse", question.id, 1)).toEqual({ ok: true });
    expect(await calls.keys("refuse", "\x1b")).toEqual({ ok: true });
    await waitUntil(() => prompts("refuse").includes(`Answer to ${question.id}: B`), "the answer");
    expect(texts("refuse")).toContain("REFUSED");
  },
  30_000,
);

test(
  "approving a permission prompt with 1 isn't a draft, and doesn't end an ask queued meanwhile",
  async () => {
    const question = await atPrompt("approve");
    expect(await calls.answer("approve", question.id, 0)).toEqual({ ok: true });
    expect(await calls.ask("approve", "status")).toEqual({ ok: true });
    expect(await calls.keys("approve", "1")).toEqual({ ok: true });
    await waitUntil(() => prompts("approve").includes(`Answer to ${question.id}: A`) && latest.approve?.asks.status?.state === "answered", "the answer and the status", 15_000);
    expect(texts("approve")).toContain("APPROVED");
  },
  40_000,
);

test(
  "a message sent while a permission prompt shows is refused, not typed into the prompt",
  async () => {
    await atPrompt("send-at-prompt");
    expect(latest["send-at-prompt"]?.isTurnOver).toBe(false);
    expect(await calls.send("send-at-prompt", "no wait, use git status")).toMatchObject({ ok: false, code: "prompt-showing" });
    await Bun.sleep(1000);
    expect(texts("send-at-prompt")).not.toContain("APPROVED");
    expect(await calls.keys("send-at-prompt", "\x1b")).toEqual({ ok: true });
    await waitUntil(() => texts("send-at-prompt").includes("REFUSED"), "the prompt to be answered");
  },
  30_000,
);
