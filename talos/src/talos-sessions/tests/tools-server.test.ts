import { expect, test } from "bun:test";
import { SESSION_ENV_KEYS, TOOLS_SERVER_SCRIPT } from "../constants";

// The session's MCP server, spoken to over stdio as Claude Code does, with no
// session runner behind it.
test(
  "it skips lines that aren't requests, answers only requests, and ends when Claude Code closes its end",
  async () => {
    const server = Bun.spawn([process.execPath, TOOLS_SERVER_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, [SESSION_ENV_KEYS.sessionName]: "s", [SESSION_ENV_KEYS.runnerSocket]: "/nowhere/hooks.sock", [SESSION_ENV_KEYS.hookToken]: "t" },
    });
    const lines = ["null", "[1,2]", '{"jsonrpc":"2.0","method":"notifications/initialized"}', '{"jsonrpc":"2.0","id":1,"method":"initialize"}', '{"jsonrpc":"2.0","id":2,"method":"no/such"}'];
    server.stdin.write(`${lines.join("\n")}\n`);
    server.stdin.end();
    const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) server.kill();
    const replies = (await new Response(server.stdout).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(exited).toBe(true);
    expect(replies.map(({ id }) => id)).toEqual([1, 2]);
    expect(replies[1].error.code).toBe(-32601);
  },
  15_000,
);
