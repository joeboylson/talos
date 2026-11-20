// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session host and prints
// back whatever decision the host returns (empty for most events). For the
// status lane the host returns a PreToolUse allow/deny or a Stop block, which
// Claude Code then enforces. If the host is slow or unreachable it denies the
// structured tools (nothing would record them) and lets everything else through,
// so it can never hold Claude up. A tool call too big for the host to read is
// denied outright, since talos can't check it.
import { parseJsonOrNull } from "talos-shared";
import { SESSION_ENV_KEYS } from "./constants";
import { encodeHookLine, readHookAnswer, type HookRequest } from "./host-protocol";
import { TALOS_LIMITS } from "./limits";
import { hookReplyWhenHostUnreachable, hookReplyWhenTooBig } from "./status-lane";

// Sends one request line and reads the host's one answer line. A big request
// goes in pieces, as the socket takes them.
const askHost = (hostSocket: string, request: HookRequest): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), TALOS_LIMITS.hookTimeoutMs);
    let unsent = Buffer.from(encodeHookLine(request));
    let received = "";
    const decoder = new TextDecoder();
    const sendMore = (socket: { write: (data: Buffer) => number }) => {
      const sentByteCount = socket.write(unsent);
      unsent = unsent.subarray(Math.max(sentByteCount, 0));
    };
    Bun.connect({
      unix: hostSocket,
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
const hostSocket = process.env[SESSION_ENV_KEYS.hostSocket];
const hookToken = process.env[SESSION_ENV_KEYS.hookToken] ?? "";

if (sessionName && hostSocket) {
  const hookDetails = await Bun.stdin.text();
  const answer = await askHost(hostSocket, { sessionName, token: hookToken, details: hookDetails })
    .then((received) => readHookAnswer(received.split("\n")[0] ?? ""))
    .catch(() => null);
  const decision =
    answer?.kind === "reply"
      ? answer.reply
      : answer?.kind === "too-big"
        ? hookReplyWhenTooBig(parseJsonOrNull(hookDetails))
        : hookReplyWhenHostUnreachable(parseJsonOrNull(hookDetails));
  if (decision) process.stdout.write(decision);
}
process.exit(0);
