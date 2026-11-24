// Checks talos's headless stream against Anthropic's own Agent SDK, which
// drives Claude Code the same way: the SDK drives the fake Claude Code the
// tests use, so the fake can't drift from what the SDK expects, and talos's
// own input lines are compared with the ones the SDK writes. No model, no
// real Claude Code. Run by `make sdk-check`, not by test.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptLine, permissionAnswerLine, userMessageLine } from "../../../talos/src/talos-sessions/stream/stream-lines";

const FAKE_CLAUDE = join(import.meta.dir, "../../../talos/src/talos-sessions/tests/fake/fake-claude.ts");
const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } } as const;
const cwd = mkdtempSync(join(tmpdir(), "talos-sdk-check-"));

// The SDK reads its messages from a stream that waits for each one.
const inbox: SDKUserMessage[] = [];
let wake: (() => void) | null = null;
async function* messages(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    yield inbox.shift()!;
  }
}
const say = (content: SDKUserMessage["message"]["content"]) => {
  inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
  wake?.();
};

const askedTools: string[] = [];
const session = query({
  prompt: messages(),
  options: {
    cwd,
    pathToClaudeCodeExecutable: FAKE_CLAUDE,
    executable: "bun",
    canUseTool: async (toolName, input) => {
      askedTools.push(toolName);
      return { behavior: "allow", updatedInput: input };
    },
  },
});

const seen: string[] = [];
const results: boolean[] = [];
void (async () => {
  for await (const message of session) {
    if (message.type === "assistant") seen.push(...message.message.content.flatMap((block: { type: string; text?: string }) => (block.text ? [block.text] : [])));
    if (message.type === "result") results.push(message.is_error);
  }
})();
const resultsReach = async (count: number): Promise<boolean> => {
  const giveUpAt = Date.now() + 10_000;
  while (results.length < count && Date.now() < giveUpAt) await Bun.sleep(50);
  return results.length >= count;
};

const checks: [string, boolean][] = [];
say("hi");
checks.push(["the SDK reads a plain turn to its result", await resultsReach(1)]);
say("prompt");
checks.push(["a permission question reaches the SDK, and its allow runs the call", (await resultsReach(2)) && askedTools.includes("Bash") && seen.includes("APPROVED")]);
say("long");
await Bun.sleep(500);
await session.interrupt();
checks.push(["the SDK's interrupt ends the turn as an error", (await resultsReach(3)) && results[2] === true]);
say([IMAGE, { type: "text", text: "look" }]);
checks.push(["the SDK's message with an image runs a turn", await resultsReach(4)]);

// What the SDK wrote, beside what talos writes for the same thing.
const written = readFileSync(join(cwd, "input.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sdkMessages = written.filter((line) => line.type === "user");
const sdkInterrupt = written.find((line) => line.request?.subtype === "interrupt");
const sdkAnswer = written.find((line) => line.type === "control_response");
const sameAs = (ours: string, theirs: unknown, ignoring: (line: Record<string, unknown>) => unknown = (line) => line) =>
  Bun.deepEquals(ignoring(JSON.parse(ours)), ignoring(theirs as Record<string, unknown>), true);
checks.push(["talos writes a message as the SDK does", sameAs(userMessageLine("hi"), sdkMessages[0])]);
checks.push(["talos writes a message with an image as the SDK does", sameAs(userMessageLine("look", [{ mediaType: "image/png", dataBase64: "AA==" }]), sdkMessages[3])]);
checks.push(["talos writes an interrupt as the SDK does", sameAs(interruptLine("id"), sdkInterrupt, (line) => ({ ...line, request_id: "id" }))]);
const { request_id: answerId, response: answer } = sdkAnswer.response;
checks.push(["talos answers a permission question as the SDK does", sameAs(permissionAnswerLine(answerId, answer.toolUseID, { allow: true, input: answer.updatedInput }), sdkAnswer)]);

checks.forEach(([name, passed]) => console.log(`${passed ? "PASS" : "FAIL"}  ${name}`));
session.close();
rmSync(cwd, { recursive: true, force: true });
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
