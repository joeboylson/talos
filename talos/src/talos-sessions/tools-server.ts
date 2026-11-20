// A tiny stdio MCP server, run once per Claude session (the session runner
// passes it with --mcp-config). It lists the structured tools, which a session
// calls to hand talos a typed answer. It only passes things along: it asks the
// session runner which tools to list, and replies with the wording it's handed.
// All checking happens in the session runner's PreToolUse check, which runs
// before a call reaches this server.
import { askRunner } from "./client/hook-client";
import type { ListedTool } from "./client/runner-protocol";
import { SESSION_ENV_KEYS, TALOS_MCP_SERVER_KEY } from "./constants";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "1.0.0";
const FIRST_RETRY_MS = 100;
const LONGEST_RETRY_MS = 5000;

const sessionName = process.env[SESSION_ENV_KEYS.sessionName] ?? "";
const runnerSocket = process.env[SESSION_ENV_KEYS.runnerSocket] ?? "";
const token = process.env[SESSION_ENV_KEYS.hookToken] ?? "";

// Keeps asking, waiting longer each time, for as long as the session runs, so a
// busy moment (like another session's flood of hooks) can't leave it without
// tools for good. A refusal won't change, so it stops there with none.
const fetchTools = async (waitMs = FIRST_RETRY_MS): Promise<ListedTool[]> => {
  const answer = await askRunner(runnerSocket, { sessionName, token, wants: "kinds" });
  if (answer?.kind === "tools") return answer.tools;
  if (answer?.kind === "refused") {
    console.error("talos tools: the session runner refused this session's token, so no tools are offered");
    return [];
  }
  await Bun.sleep(waitMs);
  return fetchTools(Math.min(waitMs * 2, LONGEST_RETRY_MS));
};

const tools = sessionName && runnerSocket ? fetchTools() : Promise.resolve([]);

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

const answerToolCall = (listed: ListedTool[], toolName: unknown) => {
  const tool = listed.find(({ name }) => name === toolName);
  return tool ? { content: [{ type: "text", text: tool.reply }] } : { content: [{ type: "text", text: "No such tool." }], isError: true };
};

for await (const line of console) {
  if (!line.trim()) continue;
  let message: { id?: unknown; method?: string; params?: { name?: string } };
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: TALOS_MCP_SERVER_KEY, version: SERVER_VERSION } });
  } else if (method === "tools/list") {
    void tools.then((listed) => reply(id, { tools: listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  } else if (method === "tools/call") {
    void tools.then((listed) => reply(id, answerToolCall(listed, params?.name)));
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    reply(id, {});
  }
}
