import { afterAll, expect, test } from "bun:test";
import { fetchMachineName } from "../../pairing";

// The machine check decides whether to keep the machine's key: only the
// server saying no (401) throws it away; any other odd reply is tried again.
const quiet = { event: () => {}, detail: () => {}, warn: () => {} };
const serveReply = (reply: () => Response) => Bun.serve({ port: 0, fetch: reply });
const servers = {
  good: serveReply(() => Response.json({ machineName: "atlas" })),
  empty: serveReply(() => Response.json({})),
  page: serveReply(() => new Response("<html>login</html>")),
  unknown: serveReply(() => new Response("no", { status: 401 })),
};
afterAll(() => Object.values(servers).forEach((server) => server.stop(true)));

test("a reply without a machine name is tried again, never taken as an unknown key", async () => {
  const check = (server: { port?: number }) =>
    fetchMachineName(`http://127.0.0.1:${server.port}`, "key", quiet as never).then((name) => name, () => "retry");
  expect(await Promise.all([servers.good, servers.empty, servers.page, servers.unknown].map(check))).toEqual(["atlas", "retry", "retry", null]);
});
