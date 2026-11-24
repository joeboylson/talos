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
let returned: { sessionName: string; text: string; requestId?: string }[] = [];
const onEvent = (event: RunnerEvent) => {
  if (event.type === "message-returned") returned = [...returned, { sessionName: event.sessionName, text: event.text, ...(event.requestId && { requestId: event.requestId }) }];
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
  // Messages still go in; an ask needs the mod, which is gone.
  expect(await calls.send("helperless", "hello")).toEqual({ ok: true });
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

test("a turn Claude Code starts on its own is marked as self-started while it runs", async () => {
  await startIn("waking", "waking");
  await waitUntil(() => stateOf("waking") === "idle", "the session to be ready");
  expect(await calls.send("waking", "wake-later")).toEqual({ ok: true });
  await waitUntil(() => summaryOf("waking")?.isSelfStarted === true && stateOf("waking") === "working", "the self-started turn");
  await waitUntil(() => stateOf("waking") === "idle" && summaryOf("waking")?.isSelfStarted === undefined, "it to end");
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

test("interrupting a turn stops it, gives back what waited, and the next message goes in as sent", async () => {
  const folder = await startIn("interrupted", "interrupted");
  await waitUntil(() => stateOf("interrupted") === "idle", "the session to be ready");
  expect(await calls.interrupt("interrupted")).toMatchObject({ ok: false, code: "not-running" });
  expect(await calls.send("interrupted", "long")).toEqual({ ok: true });
  await waitUntil(() => stateOf("interrupted") === "working", "the long turn");
  expect(await calls.send("interrupted", "said meanwhile", [], "req-1")).toEqual({ ok: true });
  await waitUntil(() => summaryOf("interrupted")?.waitingMessages?.[0] === "said meanwhile", "the message to be listed as waiting");
  expect(await calls.interrupt("interrupted")).toEqual({ ok: true });
  await waitUntil(() => returned.some(({ sessionName }) => sessionName === "interrupted"), "the message to come back");
  expect(returned.filter(({ sessionName }) => sessionName === "interrupted")).toEqual([{ sessionName: "interrupted", text: "said meanwhile", requestId: "req-1" }]);
  await waitUntil(() => stateOf("interrupted") === "idle" && summaryOf("interrupted")?.waitingMessages === undefined, "the turn to end");
  expect(await calls.send("interrupted", "what next")).toEqual({ ok: true });
  const transcript = () => readFileSync(join(folder, "transcript.jsonl"), "utf8");
  await waitUntil(() => transcript().includes("what next"), "the next message");
  expect(transcript()).toContain("[Request interrupted by user]");
  expect(transcript()).not.toContain("said meanwhile");
}, 20_000);

test("an interrupt that comes too late (the turn ended on its own) changes nothing, and the next message goes in", async () => {
  const folder = await startIn("too-late", "too-late");
  await waitUntil(() => stateOf("too-late") === "idle", "the session to be ready");
  expect(await calls.send("too-late", "deaf")).toEqual({ ok: true });
  await waitUntil(() => stateOf("too-late") === "working", "the turn");
  expect(await calls.interrupt("too-late")).toEqual({ ok: true });
  await waitUntil(() => stateOf("too-late") === "idle", "the turn to end on its own");
  expect(await calls.send("too-late", "carry on")).toEqual({ ok: true });
  const transcript = () => readFileSync(join(folder, "transcript.jsonl"), "utf8");
  await waitUntil(() => transcript().includes("carry on"), "the next message");
}, 20_000);

test("a permission prompt is listed with what it asks, and the page's Allow answers it; a second answer is closed", async () => {
  const folder = await startIn("asking", "asking");
  await waitUntil(() => stateOf("asking") === "idle", "the session to be ready");
  expect(await calls.send("asking", "prompt")).toEqual({ ok: true });
  await waitUntil(() => (summaryOf("asking")?.permissionAsks?.length ?? 0) > 0, "the prompt to be listed");
  const [ask] = summaryOf("asking")!.permissionAsks!;
  expect(ask).toEqual({ id: expect.any(String), tool: "Bash", summary: "ls" });
  expect(await calls.answerPermission("asking", ask!.id, true)).toEqual({ ok: true });
  await waitUntil(() => readFileSync(join(folder, "transcript.jsonl"), "utf8").includes("APPROVED"), "the prompt to be answered");
  await waitUntil(() => summaryOf("asking")?.permissionAsks === undefined, "the prompt to leave the list");
  expect(await calls.answerPermission("asking", ask!.id, true)).toMatchObject({ ok: false, code: "closed" });
}, 20_000);

test("the page's Deny says no to a prompt", async () => {
  const folder = await startIn("refusing", "refusing");
  await waitUntil(() => stateOf("refusing") === "idle", "the session to be ready");
  expect(await calls.send("refusing", "prompt")).toEqual({ ok: true });
  await waitUntil(() => (summaryOf("refusing")?.permissionAsks?.length ?? 0) > 0, "the prompt to be listed");
  expect(await calls.answerPermission("refusing", summaryOf("refusing")!.permissionAsks![0]!.id, false)).toEqual({ ok: true });
  await waitUntil(() => readFileSync(join(folder, "transcript.jsonl"), "utf8").includes("REFUSED"), "the prompt to be refused");
}, 20_000);
