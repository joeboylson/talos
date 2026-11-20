// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session runner and prints
// back whatever decision the session runner returns (empty for most events). For the
// status lane the session runner returns a PreToolUse allow/deny or a Stop block, which
// Claude Code then enforces. If the session runner is slow or unreachable it denies the
// structured tools (nothing would record them) and lets everything else through,
// so it can never hold Claude up. A tool call too big for the session runner to read is
// denied outright, since talos can't check it.
import { parseJsonOrNull } from "talos-shared";
import { SESSION_ENV_KEYS } from "./constants";
import { encodeHookLine, readHookAnswer, type HookRequest } from "./client/runner-protocol";
import { SESSION_LIMITS } from "./limits";
import { hookReplyWhenRunnerUnreachable, hookReplyWhenTooBig } from "./lanes/status-lane";

// Sends one request line and reads the session runner's one answer line. A big request
// goes in pieces, as the socket takes them.
const askRunner = (runnerSocket: string, request: HookRequest): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), SESSION_LIMITS.hookTimeoutMs);
    let unsent = Buffer.from(encodeHookLine(request));
    let received = "";
    const decoder = new TextDecoder();
    const sendMore = (socket: { write: (data: Buffer) => number }) => {
      const sentByteCount = socket.write(unsent);
      unsent = unsent.subarray(Math.max(sentByteCount, 0));
    };
    Bun.connect({
      unix: runnerSocket,
      socket: {
        open: sendMore,
        drain: (socket) => {
          if (unsent.length > 0) sendMore(socket);
        },
        data: (_socket, chunk) => {
          received += decoder.decode(chunk, { stream: true });
        },
        close: () => {
          clearTimeout(timer);
          resolve(received);
        },
        error: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
        connectError: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });

const sessionName = process.env[SESSION_ENV_KEYS.sessionName];
const runnerSocket = process.env[SESSION_ENV_KEYS.runnerSocket];
const hookToken = process.env[SESSION_ENV_KEYS.hookToken] ?? "";

if (sessionName && runnerSocket) {
  const hookDetails = await Bun.stdin.text();
  const answer = await askRunner(runnerSocket, { sessionName, token: hookToken, details: hookDetails })
    .then((received) => readHookAnswer(received.split("\n")[0] ?? ""))
    .catch(() => null);
  const decision =
    answer?.kind === "reply"
      ? answer.reply
      : answer?.kind === "too-big"
        ? hookReplyWhenTooBig(parseJsonOrNull(hookDetails))
        : hookReplyWhenRunnerUnreachable(parseJsonOrNull(hookDetails));
  if (decision) process.stdout.write(decision);
}
process.exit(0);
