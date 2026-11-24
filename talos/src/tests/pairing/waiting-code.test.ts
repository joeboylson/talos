import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_ROUTES } from "talos-shared";
import { pickWaitingPairing } from "../../pairing";

const ORIGIN = "https://talos.example.com";
const waiting = { serverOrigin: ORIGIN, machineName: "laptop", pairingId: "p1", userCode: "ABCD-EFGH", expiresAtMs: 2000 };

test("a saved code is shown again only for the same server and name, while it lasts", () => {
  expect(pickWaitingPairing(waiting, ORIGIN, "laptop", 1000)).toEqual(waiting);
  expect(pickWaitingPairing(waiting, ORIGIN, "laptop", 2000)).toBeNull();
  expect(pickWaitingPairing(waiting, "https://other.example.com", "laptop", 1000)).toBeNull();
  expect(pickWaitingPairing(waiting, ORIGIN, "atlas", 1000)).toBeNull();
  expect(pickWaitingPairing({ ...waiting, userCode: 5 }, ORIGIN, "laptop", 1000)).toBeNull();
  expect(pickWaitingPairing(null, ORIGIN, "laptop", 1000)).toBeNull();
});

// A stand-in server: each start makes a new code; a code waits until the test
// approves it.
let starts = 0;
let isApproved = false;
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === SERVER_ROUTES.pairStart) {
      starts += 1;
      return Response.json({ pairingId: `p${starts}`, userCode: `CODE-000${starts}`, expiresAtMs: Date.now() + 600_000 });
    }
    if (pathname === SERVER_ROUTES.pairPoll) return Response.json(isApproved ? { status: "approved", approvedBy: "joe" } : { status: "waiting" });
    if (pathname === SERVER_ROUTES.pairCollect) return Response.json({ machineKey: "id.secret", machineName: "laptop" });
    return new Response("?", { status: 404 });
  },
});
const home = mkdtempSync(join(tmpdir(), "talos-pairing-"));
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

// A child pairing in the scratch home, with a way to wait for what it prints.
const startPairing = () => {
  const child = Bun.spawn([process.execPath, new URL("./pair-in-home.ts", import.meta.url).pathname, `http://127.0.0.1:${server.port}`], {
    env: { ...process.env, TALOS_HOME: home, TALOS_PAIR_OWNER: "joe" },
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  let output = "";
  const waitFor = async (text: string): Promise<string> => {
    while (!output.includes(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    return output;
  };
  return { child, waitFor };
};

test("a talos stopped while it waits shows the same code when it starts again, and forgets it once paired", async () => {
  const first = startPairing();
  expect(await first.waitFor("CODE-")).toContain("CODE-0001");
  first.child.kill();
  await first.child.exited;

  const second = startPairing();
  expect(await second.waitFor("CODE-")).toContain("CODE-0001");
  expect(starts).toBe(1);
  isApproved = true;
  expect(await second.waitFor("KEY")).toContain("KEY id.secret");
  await second.child.exited;
  expect(existsSync(join(home, "pairing.json"))).toBe(false);
}, 30_000);
