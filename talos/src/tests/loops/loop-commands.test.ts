import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "../../commands";
import { limitFromFlags } from "../../loops/loop-commands";
import { parseUntil } from "../../loops/loop-text";

describe("loop commands", () => {
  test("parse", () => {
    expect(parseCommand(["sessions", "web", "loop"])).toEqual({ name: "sessions-loop-show", sessionName: "web" });
    expect(parseCommand(["sessions", "web", "loop", "check the build"])).toEqual({ name: "sessions-loop-start", sessionName: "web", message: "check the build" });
    expect(parseCommand(["sessions", "web", "loop", "edit"])).toEqual({ name: "sessions-loop-edit", sessionName: "web", message: null });
    expect(parseCommand(["sessions", "web", "loop", "edit", "check", "again"])).toEqual({ name: "sessions-loop-edit", sessionName: "web", message: "check again" });
    expect(parseCommand(["sessions", "web", "loop", "restart"])).toEqual({ name: "sessions-loop-restart", sessionName: "web" });
    expect(parseCommand(["sessions", "web", "loop", "stop"])).toEqual({ name: "sessions-loop-stop", sessionName: "web" });
    expect(parseCommand(["sessions", "web", "loop", "stop", "now"]).name).toBe("unknown");
  });

  test("a limit is runs or an end, never both", () => {
    expect(limitFromFlags({})).toBeNull();
    expect(limitFromFlags({ runs: "24" })).toEqual({ runs: 24 });
    expect(() => limitFromFlags({ runs: "lots" })).toThrow("whole number");
    expect(() => limitFromFlags({ runs: "2", until: "2026-11-30" })).toThrow("not both");
    expect(() => limitFromFlags({ until: "friday" })).toThrow("needs a date");
  });

  test("a date alone means the end of that day", () => {
    expect(parseUntil("2026-11-30")).toBe(new Date(2026, 10, 30, 23, 59, 59).getTime());
    expect(parseUntil("2026-11-30T09:00")).toBe(new Date(2026, 10, 30, 9, 0).getTime());
  });
});

// The real talos command and one real loop check, each in its own process
// with a scratch TALOS_HOME, beside a stand-in session runner.
describe("a loop from start to stop", () => {
  const home = mkdtempSync(join(tmpdir(), "talos-loops-"));
  const sentMessages: string[] = [];
  const running = { sessions: [{ sessionName: "web", folderName: "proj", state: "idle", asks: {}, openOutputs: [] }] };
  const runner = Bun.serve({
    unix: join(home, "runner.sock"),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response("ok");
      if (path === "/sessions") return Response.json(running.sessions);
      if (path === "/sessions/web/stop") return new Response("ok");
      if (path !== "/sessions/web/send") return new Response("?", { status: 404 });
      const { text } = (await request.json()) as { text: string };
      sentMessages.push(text);
      return new Response("ok");
      return new Response("?", { status: 404 });
    },
  });
  afterAll(() => {
    runner.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  const env = { ...process.env, TALOS_HOME: home };
  const index = new URL("../../index.ts", import.meta.url).pathname;
  const loopRunner = new URL("../../loops/loop-runner.ts", import.meta.url).pathname;
  const sessionsModule = new URL("../../talos-sessions/index.ts", import.meta.url).pathname;
  const talos = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, index, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  // One check as the session runner makes it, set a minute ahead so a run is
  // due without waiting.
  const checkOnce = async () => {
    const code = `
      import { checkLoops } from ${JSON.stringify(loopRunner)};
      import { connectToSessions } from ${JSON.stringify(sessionsModule)};
      const nowMs = Date.now() + 60_000;
      await checkLoops(connectToSessions({ home: ${JSON.stringify(home)}, runnerScript: "" }), nowMs - 59_000, nowMs, { event: console.log, detail: () => {}, warn: console.error });`;
    const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), exitCode: await child.exited };
  };

  test(
    "start, run, show, edit, restart and end with the session",
    async () => {
      const missingLimit = await talos("sessions", "web", "loop", "check the build", "--cron", "* * * * *");
      expect(missingLimit.exitCode).toBe(2);
      expect(missingLimit.stderr).toContain("a loop needs --cron and a limit");

      const noSession = await talos("sessions", "api", "loop", "hi", "--cron", "* * * * *", "--runs", "2");
      expect(noSession.stderr).toContain("there's no session api");

      const started = await talos("sessions", "web", "loop", "check the build", "--cron", "* * * * *", "--runs", "1");
      expect(started.exitCode).toBe(0);
      expect(started.stdout).toStartWith("looping web: next run ");
      expect((await talos("sessions", "web", "loop", "again", "--cron", "* * * * *", "--runs", "1")).stderr).toContain("already has a loop");

      const checked = await checkOnce();
      expect(checked.stderr).toBe("");
      expect(sentMessages).toEqual(["check the build"]);
      expect(checked.stdout).toContain("web's loop reached its limit");

      const shown = JSON.parse((await talos("sessions", "web", "loop", "--json")).stdout);
      expect(shown).toMatchObject({ message: "check the build", sentRuns: 1, hasEnded: true, nextRunMs: null });
      expect(shown.history.map((run: { outcome: string }) => run.outcome)).toEqual(["sent", "ended"]);

      expect((await talos("sessions", "../credentials", "loop")).stderr).toContain("there's no session ../credentials");
      expect((await talos("sessions", "web", "loop", "edit", "check it twice")).stdout).toContain("web's loop reached its limit; run talos sessions web loop restart");
      expect((await talos("sessions", "web", "loop", "restart", "--runs", "5")).exitCode).toBe(0);
      // loop.test.ts checks that runs count from the restart. Here the check ran
      // a minute ahead, so its "ended" run lands after the restart.
      const restarted = JSON.parse((await talos("sessions", "web", "loop", "--json")).stdout);
      expect(restarted).toMatchObject({ message: "check it twice", limit: { runs: 5 } });
      expect(restarted.startedAtMs).toBeGreaterThan(shown.startedAtMs);

      expect((await talos("sessions", "web", "stop")).exitCode).toBe(0);
      expect(existsSync(join(home, "loops", "web.json"))).toBe(false);

      expect((await talos("sessions", "web", "loop", "check the build", "--cron", "* * * * *", "--runs", "1")).exitCode).toBe(0);
      running.sessions = [];
      expect((await checkOnce()).stdout).toContain("web ended, so its loop did too");
      expect(existsSync(join(home, "loops", "web.json"))).toBe(false);
      expect((await talos("sessions", "web", "loop")).stderr).toContain("web has no loop");
    },
    30_000,
  );
});
