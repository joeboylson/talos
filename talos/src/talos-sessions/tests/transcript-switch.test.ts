import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions, mergeSessionEntries, type RunnerEvent, type SessionEntry, type SessionSummary } from "../index";

// Claude Code moves to a new conversation file on /clear and back to an old one
// on /resume. The conversation must read in the order it happened: nothing lost
// from a file it left, and nothing read twice from a file it came back to.
// Real session runner, fake Claude (tests/fake/).
const home = mkdtempSync(join(tmpdir(), "talos-transcript-switch-"));
const work = join(home, "work");
mkdirSync(work);
const calls = connectToSessions({ home, runnerScript: new URL("./fake/fake-runner.ts", import.meta.url).pathname });

let entries: SessionEntry[] = [];
let latest: SessionSummary | undefined;
const onEvent = (event: RunnerEvent) => {
  if (event.type === "sessions") latest = event.sessions.find(({ sessionName }) => sessionName === "switch");
  if (event.type === "session-entries" && event.sessionName === "switch") entries = mergeSessionEntries(entries, event.entries, 500);
};
const waitUntil = async (isDone: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!isDone()) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
// The fake's switch reports a new start mid-turn, which reads as idle, so a
// message can be typed into the turn early; that's not what this checks.
const texts = () => entries.flatMap((entry) => (entry.kind === "prompt" || entry.kind === "text" ? [entry.text] : [])).filter((text) => !text.startsWith("BUSY"));

beforeAll(async () => {
  await calls.ensureRunning();
  calls.follow(onEvent);
});
afterAll(async () => {
  await calls.stopRunner().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

test(
  "a conversation that moves to a new file and back reads in the order it happened",
  async () => {
    expect(await calls.start("switch", "work", work)).toEqual({ ok: true });
    await waitUntil(() => latest?.state === "idle", "the session to be ready");
    for (const message of ["one", "clear", "two", "resume", "three"]) {
      expect(await calls.send("switch", message)).toEqual({ ok: true });
      await waitUntil(() => texts().includes(message) && latest?.state === "idle", `"${message}"`);
    }
    await waitUntil(() => texts().length === 7, "every line", 3000).catch(() => {});
    expect(texts()).toEqual(["one", "clear", "said before clear", "two", "resume", "said before resume", "three"]);
  },
  30_000,
);
