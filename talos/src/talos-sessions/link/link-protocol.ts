// What a session's mod and the session runner say over the link. The mod keeps
// its own copy of the names here (it can't import talos-sessions); a test
// fails if the copies drift (link-protocol.test.ts).
import { SESSION_LIMITS } from "../limits";

export const LINK_ROUTES = { checkIn: "/check-in", heartbeat: "/heartbeat", toolCall: "/tool-call", toolCheck: "/tool-check", stop: "/stop" } as const;

// Set in the session's env. The token is good for one check-in; the mod
// unsets it, and swaps it for the secret it sends on every request after.
export const LINK_ENV_KEYS = { socket: "TALOS_LINK_SOCKET", token: "TALOS_LINK_TOKEN" } as const;

export type CheckIn = { token: string; sessionId: string; version: string; snapshot: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isShortText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= SESSION_LIMITS.maxIdTextLength;

export const readCheckIn = (body: unknown): CheckIn | null => {
  if (!isPlainObject(body)) return null;
  const { token, sessionId, version, snapshot } = body;
  const isCheckIn = isShortText(token) && isShortText(sessionId) && isShortText(version) && isShortText(snapshot);
  return isCheckIn ? { token, sessionId, version, snapshot } : null;
};

// The tools the mod gives the session, each named mcp__talos__<name>.
export type OfferedTool = { name: string; description: string; inputSchema: object };
export type CheckInAnswer = { secret: string; tools: OfferedTool[] };

// A call to one of talos's tools, for the runner to check. agentId marks a
// sub-agent's call. The answer is the reply the session reads, or why not.
export type ToolCallAsk = { tool: string; toolUseId: string; isSubagent: boolean; input: unknown };
export type ToolCallAnswer = { result: string } | { deny: string };
// Any other tool call the session's own turn makes: deny says it may not run
// now (an asked-for turn allows only its tool), and why.
export type ToolCheckAsk = { tool: string; isSubagent: boolean };
export type ToolCheckAnswer = { deny?: string };
// A Stop: block says to keep going (an asked-for turn not answered yet), and why.
export type StopAnswer = { block?: string };

export const readToolCheckAsk = (body: unknown): ToolCheckAsk | null => {
  if (!isPlainObject(body) || !isShortText(body.tool)) return null;
  return { tool: body.tool, isSubagent: body.agentId !== undefined && body.agentId !== null };
};

export const readToolCallAsk = (body: unknown): ToolCallAsk | null => {
  if (!isPlainObject(body)) return null;
  const { tool, toolUseId, agentId, input } = body;
  if (!isShortText(tool) || !isShortText(toolUseId)) return null;
  return { tool, toolUseId, isSubagent: agentId !== undefined && agentId !== null, input };
};
