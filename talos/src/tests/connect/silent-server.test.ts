import { afterAll, expect, test } from "bun:test";
import { connectToServer } from "../../server-connection";

// A server that takes the connection and then says nothing (frozen, or the
// network gone after a laptop woke) is taken as gone, so talos reconnects.
const server = Bun.serve({
  port: 0,
  fetch: (request, upgrader) => (upgrader.upgrade(request) ? undefined : new Response("?", { status: 400 })),
  websocket: { message: () => {} },
});
afterAll(() => server.stop(true));

test("talos closes a connection the server has gone silent on", async () => {
  const changes: boolean[] = [];
  connectToServer({
    serverUrl: `ws://127.0.0.1:${server.port}`,
    machineKey: "k",
    log: { event: () => {}, detail: () => {}, warn: () => {} },
    onConnectionChange: (isConnected) => void changes.push(isConnected),
    onOpen: () => {},
    onServerMessage: () => {},
    silentAfterMs: 300,
  });
  const giveUpAt = Date.now() + 8000;
  while (changes.length < 2 && Date.now() < giveUpAt) await Bun.sleep(50);
  expect(changes).toEqual([true, false]);
});
