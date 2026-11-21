import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../index";
import { homePaths } from "../constants";

// Stopping sessions and the session runner, on the real session runner with the
// fake Claude (tests/fake/): nothing may keep running, and trust is always put
// back, however the stop comes. Each test has its own home and runner.
const homes: string[] = [];
const runnerScript = new URL("./fake/fake-runner.ts", import.meta.url).pathname;

const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "talos-stopping-"));
  homes.push(home);
  return { home, calls: connectToSessions({ home, runnerScript }) };
};
const folderIn = (home: string, name: string) => {
  mkdirSync(join(home, name));
  return join(home, name);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidIn = (file: string): number => Number(readFileSync(file, "utf8"));
const waitUntil = async (isDone: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!(await isDone())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
const fileExists = (path: string) => Bun.file(path).exists();
const trustOf = (home: string, folder: string) => JSON.parse(readFileSync(join(home, "claude.json"), "utf8")).projects?.[realpathSync(folder)];

afterAll(async () => {
  await Promise.all(homes.map((home) => connectToSessions({ home, runnerScript }).stopRunner().catch(() => {})));
  homes.forEach((home) => rmSync(home, { recursive: true, force: true }));
});

test(
  "a stop sent while a session is starting stops it once it has",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const work = folderIn(home, "slow");
    const starting = calls.start("slow", "slow", work);
    await Bun.sleep(100);
    expect(await calls.stop("slow")).toEqual({ ok: true });
    expect(await starting).toEqual({ ok: true });
    expect(await calls.sessions()).toEqual([]);
    // Ended so soon it may not have saved its id yet; if it did, it's gone.
    await Bun.sleep(500);
    expect((await fileExists(join(work, "claude.pid"))) && isAlive(pidIn(join(work, "claude.pid")))).toBe(false);
  },
  20_000,
);

test(
  "a start while the session runner stops is turned down, and nothing is left running",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const stubborn = folderIn(home, "stubborn");
    expect(await calls.start("stubborn", "stubborn", stubborn)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(stubborn, "claude.pid")), "Claude to start");
    const stopping = calls.stopRunner();
    await Bun.sleep(300);
    await expect(calls.start("late", "late", folderIn(home, "late"))).rejects.toThrow();
    await stopping;
    expect(isAlive(pidIn(join(stubborn, "claude.pid")))).toBe(false);
    expect(await fileExists(join(home, "late", "claude.pid"))).toBe(false);
  },
  20_000,
);

test(
  "what a session started goes with it, even if it ignores the terminal closing",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const spawner = folderIn(home, "spawner");
    expect(await calls.start("spawner", "spawner", spawner)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(spawner, "child.pid")), "the child to start");
    expect(await calls.stop("spawner")).toEqual({ ok: true });
    await waitUntil(() => !isAlive(pidIn(join(spawner, "child.pid"))), "the child to be gone", 3000);
  },
  20_000,
);

test(
  "trust is put back after a runner is killed outright (by the next one) or told to stop by the system",
  async () => {
    const { home, calls } = newHome();
    const runnerPid = () => pidIn(homePaths(home).runnerLock);
    for (const signal of ["SIGKILL", "SIGTERM"] as const) {
      await calls.ensureRunning();
      const work = folderIn(home, `work-${signal}`);
      expect(await calls.start(signal.toLowerCase(), "work", work)).toEqual({ ok: true });
      expect(trustOf(home, work)?.hasTrustDialogAccepted).toBe(true);
      const killed = runnerPid();
      process.kill(killed, signal);
      await waitUntil(() => !isAlive(killed), "the runner to be gone");
      if (signal === "SIGKILL") await calls.ensureRunning();
      await waitUntil(() => trustOf(home, work)?.hasTrustDialogAccepted === undefined, `trust put back after ${signal}`);
    }
  },
  30_000,
);

test(
  "two programs starting the runner on one home at once share one runner",
  async () => {
    for (const _try of [1, 2, 3]) {
      const { home, calls } = newHome();
      const other = connectToSessions({ home, runnerScript });
      await Promise.all([calls.ensureRunning(), other.ensureRunning()]);
      const work = folderIn(home, "work");
      expect(await other.start("one", "work", work)).toEqual({ ok: true });
      expect((await calls.sessions()).map(({ sessionName }) => sessionName)).toEqual(["one"]);
      const runners = Bun.spawnSync(["pgrep", "-f", `fake-runner.ts ${home}`]).stdout.toString().trim().split("\n");
      expect(runners).toHaveLength(1);
      await calls.stopRunner();
    }
  },
  30_000,
);

test("a malformed ask or answer throws even for a session that isn't there", async () => {
  const { calls } = newHome();
  await calls.ensureRunning();
  await expect(calls.ask("nobody", "no-such-kind")).rejects.toThrow();
  await expect(calls.answer("nobody", "q1", 1.5)).rejects.toThrow();
  expect(await calls.answer("nobody", "q1", 0)).toMatchObject({ ok: false, code: "no-such-session" });
});
