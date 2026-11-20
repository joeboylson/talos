import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions, mergeSessionEntries, type RunnerEvent, type SessionEntry, type SessionSummary } from "../index";

// The real session runner, with a made-up note and question kind and a fake
// Claude (tests/fake/), checks the path the examples rely on and talos never
// uses: an output sent on its own lands in the conversation in its place, and a
// question is answered by id. No Claude, so it runs in make test.
const home = mkdtempSync(join(tmpdir(), "talos-main-path-"));
const work = join(home, "work");
mkdirSync(work);
const calls = connectToSessions({ home, runnerScript: new URL("./fake/fake-runner.ts", import.meta.url).pathname });

let entries: SessionEntry[] = [];
let latest: SessionSummary | undefined;
const onEvent = (event: RunnerEvent) => {
  if (event.type === "sessions") latest = event.sessions.find(({ sessionName }) => sessionName === "fake");
  if (event.type === "session-entries" && event.sessionName === "fake") entries = mergeSessionEntries(entries, event.entries, 500);
};

const waitUntil = async (isDone: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!isDone()) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
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
  "an output sent on its own lands in its place, and a question is answered by its id",
  async () => {
    expect(await calls.start("fake", "work", work)).toEqual({ ok: true });
    await waitUntil(() => latest?.state === "idle", "the session to be ready");

    expect(await calls.send("fake", "go")).toEqual({ ok: true });
    await waitUntil(() => (latest?.openOutputs.length ?? 0) > 0 && entries.some(({ kind }) => kind === "output"), "the note and the question");

    // The text, then the note in its call's place, then the question; the
    // structured calls themselves aren't shown.
    expect(entries.map((entry) => (entry.kind === "output" ? `${entry.outputKind}` : entry.kind))).toEqual(["prompt", "text", "note", "question"]);
    const question = latest!.openOutputs[0]!;
    expect(question).toMatchObject({ kind: "question", fields: { question: "Which one?", choices: ["A", "B"] } });

    expect(await calls.answer("fake", question.id, 1)).toEqual({ ok: true });
    expect(await calls.answer("fake", question.id, 0)).toMatchObject({ ok: false, code: "closed" });
    await waitUntil(() => entries.some((entry) => entry.kind === "prompt" && entry.text === `Answer to ${question.id}: B`), "the answer to be typed");
    await waitUntil(() => latest?.openOutputs.length === 0 && latest.state === "idle", "the question to close");

    expect(await calls.answer("fake", question.id, 0)).toMatchObject({ ok: false, code: "closed" });
    expect(await calls.stop("nobody")).toMatchObject({ ok: false, code: "no-such-session" });
  },
  30_000,
);
