// Sends one line to the session runner's hooks socket and reads its one answer
// line. Used by the hook script and the session's MCP server.
import { SESSION_LIMITS } from "../limits";
import { encodeHookLine, readHookAnswer, type HookAnswer, type HookRequest } from "./runner-protocol";

// Sends one request line and reads the session runner's one answer line. A big
// request goes in pieces, as the socket takes them. Gives null if it connected
// but no answer came: closed early, or out of time.
const askRunnerText = (runnerSocket: string, request: HookRequest): Promise<string | null> =>
  new Promise((resolve, reject) => {
    let isOpen = false;
    const timer = setTimeout(() => (isOpen ? resolve(null) : reject(new Error("timed out"))), SESSION_LIMITS.hookTimeoutMs);
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
        open: (socket) => {
          isOpen = true;
          sendMore(socket);
        },
        drain: (socket) => {
          if (unsent.length > 0) sendMore(socket);
        },
        data: (_socket, chunk) => {
          received += decoder.decode(chunk, { stream: true });
        },
        close: () => {
          clearTimeout(timer);
          resolve(received.includes("\n") ? received : null);
        },
        error: () => {
          clearTimeout(timer);
          resolve(null);
        },
        connectError: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });

// null when the session runner can't be reached or answers nonsense. no-answer
// when it was reached but didn't answer: it's there, so a call it would have
// checked mustn't run unchecked (a flood of connections can cut a hook off).
export type HookResult = HookAnswer | { kind: "no-answer" } | null;
export const askRunner = (runnerSocket: string, request: HookRequest): Promise<HookResult> =>
  askRunnerText(runnerSocket, request)
    .then((received): HookResult => (received === null ? { kind: "no-answer" } : readHookAnswer(received.split("\n")[0] ?? "")))
    .catch(() => null);
