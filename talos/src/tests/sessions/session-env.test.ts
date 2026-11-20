import { expect, test } from "bun:test";
import { buildSessionEnv, withOpenFileLimit } from "../../session-env";

test("buildSessionEnv drops Claude Code's own session marks and keeps everything else", () => {
  const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_EFFORT: "high" };
  expect(buildSessionEnv(env, { TALOS_SESSION_NAME: "fix" })).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_EFFORT: "high",
    TALOS_SESSION_NAME: "fix",
  });
});

test("withOpenFileLimit lowers the hard and soft limit, then runs the command it's given", async () => {
  const run = Bun.spawn([...withOpenFileLimit(123), "/bin/sh", "-c", "echo $(ulimit -Hn) $(ulimit -Sn)"], { stdout: "pipe" });
  expect((await new Response(run.stdout).text()).trim()).toBe("123 123");
});
