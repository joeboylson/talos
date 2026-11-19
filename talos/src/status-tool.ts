// A tiny stdio MCP server, run once per Claude session (the host passes it with
// --mcp-config). It exposes a single prescoped tool, report_status, which a
// session calls to report its own status. The schema makes the reply typed;
// the host takes the report from the call's PreToolUse hook, so this server
// never calls back into the host (no new host-socket surface).
import { REPORTED_STATUSES } from "talos-shared";
import { STATUS_TOOL_BARE_NAME } from "./constants";
import { readStatusReport } from "./status-lane";

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

const tool = {
  name: STATUS_TOOL_BARE_NAME,
  description:
    "Report THIS session's current status. Call once with your state and one short line. " +
    "state is one of: " + REPORTED_STATUSES.join(", ") + ".",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: [...REPORTED_STATUSES] },
      note: { type: "string", description: "one short line, at most ~280 characters" },
    },
    required: ["state", "note"],
  },
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
    reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "talosstatus", version: "1.0.0" } });
  } else if (method === "tools/list") {
    reply(id, { tools: [tool] });
  } else if (method === "tools/call") {
    const isReport = params?.name === STATUS_TOOL_BARE_NAME && readStatusReport(params?.arguments) !== null;
    if (isReport) reply(id, { content: [{ type: "text", text: "Status recorded." }] });
    else reply(id, { content: [{ type: "text", text: `Rejected: call ${STATUS_TOOL_BARE_NAME} with state (${REPORTED_STATUSES.join("/")}) and a short note.` }], isError: true });
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    reply(id, {});
  }
}
