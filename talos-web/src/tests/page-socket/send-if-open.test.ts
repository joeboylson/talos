import { expect, test } from "bun:test";
import { sendIfOpen } from "../../hooks/use-server-socket";

// A message for a socket that isn't open isn't sent, so the page can say so
// instead of showing it as waiting for good.
const socketIn = (readyState: number) => {
  const sent: string[] = [];
  return { sent, socket: { readyState, send: (text: string) => void sent.push(text) } };
};

test("sends on an open socket", () => {
  const { sent, socket } = socketIn(WebSocket.OPEN);
  expect(sendIfOpen(socket, "hi")).toBe(true);
  expect(sent).toEqual(["hi"]);
});

test.each([WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED])("doesn't send on a socket in state %p", (readyState) => {
  const { sent, socket } = socketIn(readyState);
  expect(sendIfOpen(socket, "hi")).toBe(false);
  expect(sent).toEqual([]);
});

test("doesn't send with no socket yet", () => expect(sendIfOpen(null, "hi")).toBe(false));
