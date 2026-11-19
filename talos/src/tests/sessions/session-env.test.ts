import { expect, test } from "bun:test";
import { buildSessionEnv } from "../../session-env";

test("buildSessionEnv drops Claude Code's own session marks and keeps everything else", () => {
  const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_EFFORT: "high" };
  expect(buildSessionEnv(env, { TALOS_SESSION_NAME: "fix" })).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_EFFORT: "high",
    TALOS_SESSION_NAME: "fix",
  });
});
