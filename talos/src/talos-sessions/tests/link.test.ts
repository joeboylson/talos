import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions, type RunnerEvent, type SessionSummary } from "../index";

// The real session runner and the fake Claude, which links as talos's mod does
// and runs the mod's real helper.
const home = mkdtempSync(join(tmpdir(), "talos-link-"));
const calls = connectToSessions({ home, runnerScript: new URL("./fake/fake-runner.ts", import.meta.url).pathname });

let sessions: SessionSummary[] = [];
const onEvent = (event: RunnerEvent) => {
  if (event.type === "sessions") sessions = event.sessions;
};
const linkOf = (sessionName: string) => sessions.find((session) => session.sessionName === sessionName)?.link;

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
}, 20_000);

test("a second check-in, from a mod that started over, loses the link", async () => {
  await startIn("relinked", "relink");
  await waitUntil(() => linkOf("relinked") === "lost", "the second check-in");
});
