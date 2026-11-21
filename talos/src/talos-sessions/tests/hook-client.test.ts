import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askRunner } from "../client/hook-client";
import { HOOK_SCRIPT, SESSION_ENV_KEYS } from "../constants";

// A runner that's there but doesn't answer (closed under a flood of connections,
// or too slow) must not let a call through that it would have checked.
const folder = mkdtempSync(join(tmpdir(), "talos-hook-client-"));
const silentSocket = join(folder, "silent.sock");
const silent = Bun.listen({ unix: silentSocket, socket: { data: (socket) => void socket.end() } });
afterAll(() => {
  silent.stop(true);
  rmSync(folder, { recursive: true, force: true });
});

const runHook = (runnerSocket: string, details: object) =>
  Bun.spawnSync([process.execPath, HOOK_SCRIPT], {
    stdin: Buffer.from(JSON.stringify(details)),
    env: { ...process.env, [SESSION_ENV_KEYS.sessionName]: "s", [SESSION_ENV_KEYS.runnerSocket]: runnerSocket, [SESSION_ENV_KEYS.hookToken]: "t" },
  }).stdout.toString();
const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" };

test("a runner reached that gives no answer is told apart from one that isn't there", async () => {
  expect(await askRunner(silentSocket, { sessionName: "s", token: "t", details: "{}" })).toEqual({ kind: "no-answer" });
  expect(await askRunner(join(folder, "none.sock"), { sessionName: "s", token: "t", details: "{}" })).toBeNull();
});

test("a tool call the runner was reached for but didn't answer is denied; with no runner, it runs", () => {
  expect(JSON.parse(runHook(silentSocket, bash)).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(runHook(join(folder, "none.sock"), bash)).toBe("");
});
