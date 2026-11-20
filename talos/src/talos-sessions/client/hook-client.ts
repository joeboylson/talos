// Sends one line to the session runner's hooks socket and reads its one answer
// line. Used by the hook script and the session's MCP server.
import { SESSION_LIMITS } from "../limits";
import { encodeHookLine, readHookAnswer, type HookAnswer, type HookRequest } from "./runner-protocol";

// Sends one request line and reads the session runner's one answer line. A big request
// goes in pieces, as the socket takes them.
const askRunnerText = (runnerSocket: string, request: HookRequest): Promise<string> =>
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

// null when the session runner can't be reached or answers nonsense.
export const askRunner = (runnerSocket: string, request: HookRequest): Promise<HookAnswer | null> =>
  askRunnerText(runnerSocket, request)
    .then((received) => readHookAnswer(received.split("\n")[0] ?? ""))
    .catch(() => null);
