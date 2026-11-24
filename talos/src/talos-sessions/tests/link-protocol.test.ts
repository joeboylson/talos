import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_ENV_KEYS, LINK_ROUTES, readCheckIn, readToolCallAsk, readToolCheckAsk } from "../link/link-protocol";
import { MOD_FOLDER } from "../constants";
import { mcpToolName } from "../kinds";
import { SESSION_LIMITS } from "../limits";

test("a check-in needs every field, each short text", () => {
  const checkIn = { token: "t", sessionId: "s", version: "2.1.330", snapshot: "abc" };
  expect(readCheckIn(checkIn)).toEqual(checkIn);
  expect(readCheckIn({ ...checkIn, token: "" })).toBeNull();
  expect(readCheckIn({ ...checkIn, version: 2 })).toBeNull();
  expect(readCheckIn({ ...checkIn, snapshot: "x".repeat(SESSION_LIMITS.maxIdTextLength + 1) })).toBeNull();
});

test("a tool check needs its tool; agentId marks a sub-agent's", () => {
  expect(readToolCheckAsk({ tool: "Bash" })).toEqual({ tool: "Bash", isSubagent: false });
  expect(readToolCheckAsk({ tool: "Bash", agentId: "a1" })?.isSubagent).toBe(true);
  expect(readToolCheckAsk({ tool: "" })).toBeNull();
});

test("a tool call needs its tool and call id; agentId marks a sub-agent's", () => {
  const ask = { tool: "mcp__talos__send_note", toolUseId: "tu", input: { text: "hi" } };
  expect(readToolCallAsk(ask)).toEqual({ ...ask, isSubagent: false });
  expect(readToolCallAsk({ ...ask, agentId: "a1" })?.isSubagent).toBe(true);
  expect(readToolCallAsk({ ...ask, toolUseId: "" })).toBeNull();
  expect(readToolCallAsk({ ...ask, tool: 5 })).toBeNull();
  expect(readToolCallAsk("no")).toBeNull();
});

// The mod can't import these, so it spells them out; they must match.
test("the mod's copies of the link's names match", () => {
  const modSource = readFileSync(join(MOD_FOLDER, "hooks", "register.ts"), "utf8");
  const names = [...Object.values(LINK_ROUTES).map((route) => `http://talos${route}`), ...Object.values(LINK_ENV_KEYS)];
  expect(names.filter((name) => !modSource.includes(name))).toEqual([]);
  expect(modSource).toContain(`{ tool: /^${mcpToolName("")}/ }`);
});
