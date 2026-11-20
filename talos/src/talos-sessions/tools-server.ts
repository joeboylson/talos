// A tiny stdio MCP server, run once per Claude session (the session runner passes it with
// --mcp-config). It exposes talos's structured tools (see structured-tools.ts),
// which a session calls to hand talos a typed answer. The session runner takes each answer
// from the call's PreToolUse hook, so this server never calls back into the session runner
// (no new runner-socket surface); it only checks the input and replies.
import { STRUCTURED_TOOLS } from "./structured-tools";
import { TALOS_MCP_SERVER_KEY } from "./constants";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "1.0.0";

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

const listedTools = STRUCTURED_TOOLS.map(({ bareName, description, inputSchema }) => ({ name: bareName, description, inputSchema }));

const answerToolCall = (toolName: unknown, toolInput: unknown) => {
  const tool = STRUCTURED_TOOLS.find(({ bareName }) => bareName === toolName);
  if (!tool) return { content: [{ type: "text", text: "No such tool." }], isError: true };
  const isAccepted = tool.readInput(toolInput, Date.now()) !== null;
  if (isAccepted) return { content: [{ type: "text", text: tool.acceptedReply }] };
  return { content: [{ type: "text", text: `Rejected: ${tool.badInputReason}` }], isError: true };
};

for await (const line of console) {
  if (!line.trim()) continue;
  let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: TALOS_MCP_SERVER_KEY, version: SERVER_VERSION } });
  } else if (method === "tools/list") {
    reply(id, { tools: listedTools });
  } else if (method === "tools/call") {
    reply(id, answerToolCall(params?.name, params?.arguments));
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    reply(id, {});
  }
}
