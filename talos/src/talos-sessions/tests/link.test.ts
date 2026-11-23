import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions, type RunnerEvent, type SessionSummary } from "../index";

// The real session runner and the fake Claude, which links as talos's mod does
// and runs the mod's real helper.
const home = mkdtempSync(join(tmpdir(), "talos-link-"));
// A mod quiet for 2 s counts as gone, so a test can see it.
process.env.FAKE_LINK_SILENCE_MS = "2000";
const calls = connectToSessions({ home, runnerScript: new URL("./fake/fake-runner.ts", import.meta.url).pathname });

let sessions: SessionSummary[] = [];
let notices: string[] = [];
const onEvent = (event: RunnerEvent) => {
  if (event.type === "sessions") sessions = event.sessions;
  if (event.type === "notice") notices = [...notices, `${event.sessionName}: ${event.message}`];
};
const summaryOf = (sessionName: string) => sessions.find((session) => session.sessionName === sessionName);
const linkOf = (sessionName: string) => summaryOf(sessionName)?.link;
const stateOf = (sessionName: string) => summaryOf(sessionName)?.state;

const waitUntil = async (isDone: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!isDone()) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

const startIn = async (sessionName: string, folderName: string): Promise<string> => {
  const folder = join(home, folderName);
  mkdirSync(folder);
  expect(await calls.start(sessionName, folderName, folder)).toEqual({ ok: true });
  return folder;
};

beforeAll(async () => {
  await calls.ensureRunning();
  calls.follow(onEvent);
});
afterAll(async () => {
  await calls.stopRunner().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

test("a session's mod checks in and its link shows as up", async () => {
  await startIn("linked", "work");
  await waitUntil(() => linkOf("linked") === "linked", "the check-in");
});

test("a session whose helper is gone shows its link lost, and keeps running", async () => {
  const folder = await startIn("helperless", "helperless");
  await waitUntil(() => linkOf("helperless") === "linked", "the check-in");
  await waitUntil(() => {
    try {
      return readFileSync(join(folder, "helper.pid"), "utf8").length > 0;
    } catch {
      return false;
    }
  }, "the helper");
  process.kill(Number(readFileSync(join(folder, "helper.pid"), "utf8")), "SIGKILL");
  await waitUntil(() => linkOf("helperless") === "lost", "the link to be lost", 15_000);
  expect(sessions.some((session) => session.sessionName === "helperless")).toBe(true);
  // talos can't see where it is now, so it sends nothing.
  expect(await calls.send("helperless", "hello")).toMatchObject({ ok: false, code: "link-lost" });
  expect(await calls.ask("helperless", "status")).toMatchObject({ ok: false, code: "link-lost" });
}, 20_000);

test("a second check-in, from a mod that started over, loses the link", async () => {
  await startIn("relinked", "relink");
  await waitUntil(() => linkOf("relinked") === "lost", "the second check-in");
});

test("a session whose mod goes quiet shows its link lost", async () => {
  await startIn("quiet", "quiet");
  await waitUntil(() => linkOf("quiet") === "linked", "the check-in");
  await waitUntil(() => linkOf("quiet") === "lost", "the link to be lost", 15_000);
}, 20_000);

test("a session that keeps sending word keeps its link", async () => {
  await startIn("chatty", "chatty");
  await waitUntil(() => linkOf("chatty") === "linked", "the check-in");
  await Bun.sleep(8_000);
  expect(linkOf("chatty")).toBe("linked");
}, 15_000);

test("Esc mid-turn stops a session: the page's messages are refused until the person continues it at the terminal", async () => {
  await startIn("stopped", "stopped");
  await waitUntil(() => stateOf("stopped") === "idle", "the session to be ready");
  expect(await calls.send("stopped", "stop-me")).toEqual({ ok: true });
  await waitUntil(() => stateOf("stopped") === "stopped", "the session to stop");
  expect(await calls.send("stopped", "from the page")).toMatchObject({ ok: false, code: "stopped" });
  expect(await calls.keys("stopped", "typed at the terminal\r")).toEqual({ ok: true });
  await waitUntil(() => stateOf("stopped") === "idle", "the session to go on");
}, 20_000);

test("a turn Claude Code starts on its own is marked as self-started while it runs", async () => {
  await startIn("waking", "waking");
  await waitUntil(() => stateOf("waking") === "idle", "the session to be ready");
  expect(await calls.send("waking", "wake-later")).toEqual({ ok: true });
  await waitUntil(() => summaryOf("waking")?.isSelfStarted === true && stateOf("waking") === "working", "the self-started turn");
  await waitUntil(() => stateOf("waking") === "idle" && summaryOf("waking")?.isSelfStarted === undefined, "it to end");
}, 20_000);

test("an answer held while a session is stopped isn't typed into the turn the person continues it with", async () => {
  const folder = await startIn("held", "held");
  await waitUntil(() => stateOf("held") === "idle", "the session to be ready");
  expect(await calls.send("held", "go")).toEqual({ ok: true });
  await waitUntil(() => stateOf("held") === "needs-you" && summaryOf("held")?.isTurnOver === true, "the question, its turn over");
  const question = summaryOf("held")!.openOutputs.find(({ kind }) => kind === "question")!;
  expect(await calls.send("held", "stop-me")).toEqual({ ok: true });
  await waitUntil(() => stateOf("held") === "stopped", "the session to stop");
  expect(await calls.answer("held", question.id, 0)).toEqual({ ok: true });
  await Bun.sleep(500);
  expect(await calls.keys("held", "go on\r")).toEqual({ ok: true });
  const transcript = () => readFileSync(join(folder, "transcript.jsonl"), "utf8");
  await waitUntil(() => transcript().includes("go on") && stateOf("held") !== "working", "the person's turn to end");
  await Bun.sleep(1000);
  expect(transcript()).not.toContain(`BUSY Answer to ${question.id}`);
}, 20_000);

test("a message Claude Code drops is reported, and the next one still goes in", async () => {
  const folder = await startIn("dropping", "dropping");
  await waitUntil(() => stateOf("dropping") === "idle", "the session to be ready");
  expect(await calls.send("dropping", "drop-me")).toEqual({ ok: true });
  await waitUntil(() => notices.some((notice) => notice.startsWith("dropping: A message didn't go in")), "the notice");
  expect(await calls.send("dropping", "after the drop")).toEqual({ ok: true });
  await waitUntil(() => readFileSync(join(folder, "transcript.jsonl"), "utf8").includes("after the drop"), "the next message to go in");
}, 20_000);

test("what talos sends while Claude Code runs a turn of its own waits for it, so only one send is ever queued in Claude Code", async () => {
  const folder = await startIn("queued", "queued");
  await waitUntil(() => stateOf("queued") === "idle", "the session to be ready");
  expect(await calls.send("queued", "wake-later")).toEqual({ ok: true });
  await waitUntil(() => stateOf("queued") === "working", "the first turn");
  expect(await calls.send("queued", "first-after")).toEqual({ ok: true });
  expect(await calls.send("queued", "second-after")).toEqual({ ok: true });
  const submits = () => (existsSync(join(folder, "submits.log")) ? readFileSync(join(folder, "submits.log"), "utf8") : "");
  await waitUntil(() => submits().includes("second-after"), "both to be sent", 15_000);
  expect(submits()).toContain("second-after behind 0");
}, 20_000);
