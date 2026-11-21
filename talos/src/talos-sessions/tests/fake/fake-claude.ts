// A stand-in for Claude Code, for the main-path test: it reports to the session
// runner through the same hooks, and saves its conversation the same way, but
// follows a fixed script instead of thinking. On "go" it writes a line of text,
// sends a note (an output that doesn't wait) and a question (one that waits),
// and ends its turn. Any other message is a prompt it just answers by ending
// its turn.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askRunner } from "../../client/hook-client";
import { SESSION_ENV_KEYS } from "../../constants";

const sessionName = process.env[SESSION_ENV_KEYS.sessionName] ?? "";
const runnerSocket = process.env[SESSION_ENV_KEYS.runnerSocket] ?? "";
const token = process.env[SESSION_ENV_KEYS.hookToken] ?? "";
const transcriptPath = join(process.cwd(), "transcript.jsonl");
writeFileSync(transcriptPath, "");

let lineNumber = 0;
const saveLine = (line: object) => {
  lineNumber += 1;
  appendFileSync(transcriptPath, `${JSON.stringify({ uuid: `line-${lineNumber}`, ...line })}\n`);
};

const hook = async (details: object): Promise<string> => {
  const answer = await askRunner(runnerSocket, { sessionName, token, details: JSON.stringify({ transcript_path: transcriptPath, ...details }) });
  return answer?.kind === "reply" ? answer.reply : "";
};

// Calls one structured tool as Claude Code would: its PreToolUse, then (if
// allowed) its call saved in the conversation and its PostToolUse with the
// input the hook handed back.
const callTool = async (toolName: string, input: object, toolUseId: string) => {
  const reply = JSON.parse((await hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: toolUseId })) || "{}");
  if (reply.hookSpecificOutput?.permissionDecision !== "allow") return;
  saveLine({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] } });
  await hook({ hook_event_name: "PostToolUse", tool_name: toolName, tool_input: reply.hookSpecificOutput.updatedInput, tool_use_id: toolUseId });
};

const prompted = async (text: string) => {
  await hook({ hook_event_name: "UserPromptSubmit", prompt: text });
  saveLine({ type: "user", message: { content: text } });
};

await hook({ hook_event_name: "SessionStart" });
process.stdout.write("ready\n");

// What the session runner types: Esc, then the message in bracketed paste.
for await (const typed of console) {
  const text = typed.replace(/\x1b\[20[01]~/g, "").replace(/\x1b/g, "").trim();
  if (!text) continue;
  await prompted(text);
  if (text === "go") {
    saveLine({ type: "assistant", message: { content: [{ type: "text", text: "Here is a note, then a question." }] } });
    await callTool("mcp__talos__send_note", { text: "a note" }, "tool-note");
    await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] }, "tool-question");
  }
  await hook({ hook_event_name: "Stop" });
  process.stdout.write("done\n");
}
