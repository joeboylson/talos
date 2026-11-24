// Claude Code run headless speaks JSON lines: talos writes messages and
// control requests to its input, and reads the conversation, the end of each
// turn and its permission questions from its output. The shapes follow the
// Agent SDK's own (claude-agent-sdk-python, _internal/query.py).
import { parseJsonOrNull } from "../json";
import { readTranscriptValue, type TranscriptItem } from "../transcript/transcript-lines";

// What one output line means to the runner. A conversation line is read with
// the transcript's own rules, so the page shows the same entries either way.
export type StreamEvent =
  | { type: "init"; sessionId: string }
  | { type: "conversation"; items: TranscriptItem[] }
  | { type: "turn-over"; isError: boolean }
  | { type: "permission-ask"; requestId: string; toolUseId: string; tool: string; input: unknown }
  | { type: "permission-cancel"; requestId: string }
  | { type: "control-answer"; requestId: string; isOk: boolean }
  | { type: "reset"; conversationId: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textField = (value: Record<string, unknown>, field: string): string | null => (typeof value[field] === "string" ? (value[field] as string) : null);

const readControlRequest = (line: Record<string, unknown>): StreamEvent | null => {
  const requestId = textField(line, "request_id");
  const request = line.request;
  if (!requestId || !isPlainObject(request) || request.subtype !== "can_use_tool") return null;
  const tool = textField(request, "tool_name");
  const toolUseId = textField(request, "tool_use_id");
  return tool && toolUseId ? { type: "permission-ask", requestId, toolUseId, tool, input: request.input } : null;
};

const readControlAnswer = (line: Record<string, unknown>): StreamEvent | null => {
  const response = line.response;
  const requestId = isPlainObject(response) ? textField(response, "request_id") : null;
  return requestId && isPlainObject(response) ? { type: "control-answer", requestId, isOk: response.subtype === "success" } : null;
};

// A line a sub-agent's work made (parent_tool_use_id set) isn't the session's
// own conversation, as a sub-agent's lines in the saved file aren't.
export const readStreamLine = (lineText: string): StreamEvent | null => {
  const line = parseJsonOrNull(lineText);
  if (!isPlainObject(line)) return null;
  const { type } = line;
  if (type === "assistant" || type === "user") {
    const isSubagent = line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined;
    return isSubagent ? null : { type: "conversation", items: readTranscriptValue(line) };
  }
  if (type === "result") return { type: "turn-over", isError: line.is_error === true };
  if (type === "system" && line.subtype === "init") {
    const sessionId = textField(line, "session_id");
    return sessionId ? { type: "init", sessionId } : null;
  }
  if (type === "control_request") return readControlRequest(line);
  if (type === "control_cancel_request") {
    const requestId = textField(line, "request_id");
    return requestId ? { type: "permission-cancel", requestId } : null;
  }
  if (type === "control_response") return readControlAnswer(line);
  if (type === "conversation_reset") {
    const conversationId = textField(line, "new_conversation_id");
    return conversationId ? { type: "reset", conversationId } : null;
  }
  return null;
};

export type StreamImage = { mediaType: string; dataBase64: string };

// A message as the person's own, its images first as Claude Code puts them.
export const userMessageLine = (text: string, images: readonly StreamImage[] = []): string => {
  const imageBlocks = images.map(({ mediaType, dataBase64 }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data: dataBase64 } }));
  const content = imageBlocks.length === 0 ? text : [...imageBlocks, { type: "text", text }];
  return `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })}\n`;
};

export const interruptLine = (requestId: string): string =>
  `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;

// Allow runs the call as asked; deny gives Claude the reason as the call's error.
export const permissionAnswerLine = (requestId: string, answer: { allow: true; input: unknown } | { allow: false; message: string }): string => {
  const response = answer.allow ? { behavior: "allow", updatedInput: answer.input } : { behavior: "deny", message: answer.message };
  return `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`;
};
