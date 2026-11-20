import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Logger } from "talos-shared";
import type { MachineRecord, MachinesTable } from "../../machines-table";
import { createPairingRoutes } from "../../pairing-routes";
import type { RequestChecks } from "../../request-checks";
import { allowAttempt, allowBytes, readClientAddress } from "../../utils/rate-limit";
import { PAIRING_LIFETIME_MS } from "../../constants";
import { SERVER_LIMITS } from "../../limits";

const ORIGIN = "https://talos.test";
const people = { joe: { personId: "joe", signInId: "github-id:1", displayName: "joe" }, eve: { personId: "eve", signInId: "github-id:2", displayName: "eve" } };

const setUp = (existingMachines: MachineRecord[] = []) => {
  const logLines: string[] = [];
  const log: Logger = { event: (line) => logLines.push(line), detail: (line) => logLines.push(line), warn: (line) => logLines.push(line) };
  const savedMachines: MachineRecord[] = [...existingMachines];
  const machinesTable = {
    listMachines: async () => savedMachines,
    saveMachine: async (machine: MachineRecord) => void savedMachines.push(machine),
  } as unknown as MachinesTable;
  // The fake sign-in check reads who is asking from a test-only header.
  const checks = {
    readTrustedPerson: async (request: Request) => people[request.headers.get("x-test-person") as keyof typeof people] ?? null,
  } as unknown as RequestChecks;
  const routes = createPairingRoutes(machinesTable, checks, async () => {}, log);
  const post = (body: unknown, person?: keyof typeof people) =>
    new Request(ORIGIN, { method: "POST", body: JSON.stringify(body), headers: person ? { "x-test-person": person } : {} });
  return { routes, post, savedMachines, logLines };
};

const startPairing = async ({ routes, post }: ReturnType<typeof setUp>, address = "1.2.3.4") =>
  (await (await routes.start(post({ machineName: "atlas" }), address)).json()) as { pairingId: string; userCode: string };

describe("pairing", () => {
  test("entering a code makes no machine and no key until the machine confirms", async () => {
    const setup = setUp();
    const { pairingId, userCode } = await startPairing(setup);
    expect((await setup.routes.approve(setup.post({ userCode }, "joe"))).status).toBe(200);
    expect(setup.savedMachines).toEqual([]);
    expect(await (await setup.routes.poll(setup.post({ pairingId }))).json()).toEqual({ status: "approved", approvedBy: "joe" });

    const collected = (await (await setup.routes.collect(setup.post({ pairingId }))).json()) as { machineKey: string };
    expect(collected.machineKey).toBeString();
    expect(setup.savedMachines.map((machine) => machine.ownerPersonId)).toEqual(["joe"]);
  });

  test("a code can be approved once: someone entering it second gets nothing", async () => {
    const setup = setUp();
    const { userCode } = await startPairing(setup);
    const [first, second] = await Promise.all([
      setup.routes.approve(setup.post({ userCode }, "eve")),
      setup.routes.approve(setup.post({ userCode }, "joe")),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 404]);
  });

  test("concurrent collects of one pairing mint exactly one key", async () => {
    const setup = setUp();
    const { pairingId, userCode } = await startPairing(setup);
    await setup.routes.approve(setup.post({ userCode }, "joe"));
    const results = await Promise.all(Array.from({ length: 12 }, () => setup.routes.collect(setup.post({ pairingId }))));
    expect(results.filter((response) => response.status === 200).length).toBe(1);
    expect(setup.savedMachines.length).toBe(1);
  });

  test("the key can be collected once", async () => {
    const setup = setUp();
    const { pairingId, userCode } = await startPairing(setup);
    await setup.routes.approve(setup.post({ userCode }, "joe"));
    expect((await setup.routes.collect(setup.post({ pairingId }))).status).toBe(200);
    expect((await setup.routes.collect(setup.post({ pairingId }))).status).toBe(404);
  });

  test("nothing can be collected before someone approves", async () => {
    const setup = setUp();
    const { pairingId } = await startPairing(setup);
    expect((await setup.routes.collect(setup.post({ pairingId }))).status).toBe(404);
  });

  test("approving needs a sign-in", async () => {
    const setup = setUp();
    const { userCode } = await startPairing(setup);
    expect((await setup.routes.approve(setup.post({ userCode }))).status).toBe(401);
  });

  test("codes never go into the logs", async () => {
    const setup = setUp();
    const { userCode } = await startPairing(setup);
    await setup.routes.approve(setup.post({ userCode }, "joe"));
    expect(setup.logLines.join("\n")).not.toContain(userCode);
  });

  test("one address can only start a few pairings at a time", async () => {
    const setup = setUp();
    const statuses = await Promise.all(
      Array.from({ length: SERVER_LIMITS.pairStart.maxAttempts + 1 }, () => setup.routes.start(setup.post({ machineName: "x" }), "6.6.6.6")),
    );
    expect(statuses.map((response) => response.status).at(-1)).toBe(429);
    expect((await setup.routes.start(setup.post({ machineName: "x" }), "1.1.1.1")).status).toBe(200);
  });

  test("a person can't have more than the machine limit", async () => {
    const full = Array.from({ length: SERVER_LIMITS.maxMachinesPerPerson }, (_, index) => ({
      machineId: `m${index}`, machineName: `m${index}`, ownerPersonId: "joe", keyHash: "h", pairedAtMs: 0,
    }));
    const setup = setUp(full);
    const { pairingId, userCode } = await startPairing(setup);
    await setup.routes.approve(setup.post({ userCode }, "joe"));
    expect((await setup.routes.collect(setup.post({ pairingId }))).status).toBe(409);
  });
});

describe("pairing over time and limits", () => {
  afterEach(() => setSystemTime());
  const freezeAt = (nowMs: number) => setSystemTime(new Date(nowMs));

  test("a code can't be approved once it has expired, even at the very moment it expires", async () => {
    const startMs = Date.now();
    freezeAt(startMs);
    const setup = setUp();
    const { userCode } = await startPairing(setup);
    freezeAt(startMs + PAIRING_LIFETIME_MS);
    expect((await setup.routes.approve(setup.post({ userCode }, "joe"))).status).toBe(404);
  });

  test("polling an expired pairing says so", async () => {
    const startMs = Date.now();
    freezeAt(startMs);
    const setup = setUp();
    const { pairingId } = await startPairing(setup);
    freezeAt(startMs + PAIRING_LIFETIME_MS);
    expect(await (await setup.routes.poll(setup.post({ pairingId }))).json()).toEqual({ status: "expired" });
  });

  test("one address can't hold more than its share of waiting pairings", async () => {
    const setup = setUp();
    const statuses = [];
    for (let index = 0; index <= SERVER_LIMITS.maxWaitingPairingsPerAddress; index += 1) {
      statuses.push((await setup.routes.start(setup.post({ machineName: "x" }), "5.5.5.5")).status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
  });

  test("starting counts every attempt, even ones that went nowhere", async () => {
    const setup = setUp();
    for (let index = 0; index < SERVER_LIMITS.pairStart.maxAttempts; index += 1) {
      expect((await setup.routes.start(setup.post({}), "7.7.7.7")).status).toBe(400);
    }
    expect((await setup.routes.start(setup.post({ machineName: "atlas" }), "7.7.7.7")).status).toBe(429);
  });

  test("a person entering too many codes is slowed down", async () => {
    const setup = setUp();
    for (let index = 0; index < SERVER_LIMITS.pairApprove.maxAttempts; index += 1) {
      expect((await setup.routes.approve(setup.post({ userCode: "AAAA-AAAA" }, "joe"))).status).toBe(404);
    }
    expect((await setup.routes.approve(setup.post({ userCode: "AAAA-AAAA" }, "joe"))).status).toBe(429);
  });

  test("the machine limit counts only the approver's own machines", async () => {
    const evesMachines = Array.from({ length: SERVER_LIMITS.maxMachinesPerPerson }, (_, index) => ({
      machineId: `e${index}`, machineName: `e${index}`, ownerPersonId: "eve", keyHash: "h", pairedAtMs: 0,
    }));
    const setup = setUp(evesMachines);
    const { pairingId, userCode } = await startPairing(setup);
    await setup.routes.approve(setup.post({ userCode }, "joe"));
    expect((await setup.routes.collect(setup.post({ pairingId }))).status).toBe(200);
  });

  test("a machine name at the length limit is fine", async () => {
    const setup = setUp();
    const longestName = "a".repeat(SERVER_LIMITS.maxMachineNameLength);
    expect((await setup.routes.start(setup.post({ machineName: longestName }), "8.8.8.8")).status).toBe(200);
  });
});

describe("allowAttempt", () => {
  const limit = { windowMs: 1000, maxAttempts: 2 };
  test("allows up to the limit in the window, then refuses", () => {
    expect(allowAttempt([], 0, limit)).toEqual({ isAllowed: true, timesMs: [0] });
    expect(allowAttempt([0, 10], 20, limit)).toEqual({ isAllowed: false, timesMs: [0, 10] });
  });
  test("old attempts fall out of the window", () => {
    expect(allowAttempt([0, 10], 1500, limit)).toEqual({ isAllowed: true, timesMs: [1500] });
  });
  test("an attempt exactly one window old has fallen out", () => {
    expect(allowAttempt([0, 500], 1000, limit)).toEqual({ isAllowed: true, timesMs: [500, 1000] });
  });
});

describe("allowBytes", () => {
  const limit = { windowMs: 1000, maxBytes: 100 };
  test("allows up to the byte budget in the window, then drops", () => {
    expect(allowBytes(undefined, 0, 60, limit)).toEqual({ isAllowed: true, window: { startMs: 0, bytes: 60 } });
    // A message over the remaining budget is dropped and NOT counted (it wasn't parsed)...
    expect(allowBytes({ startMs: 0, bytes: 60 }, 10, 60, limit)).toEqual({ isAllowed: false, window: { startMs: 0, bytes: 60 } });
    // ...so a small one still fits.
    expect(allowBytes({ startMs: 0, bytes: 60 }, 10, 40, limit)).toEqual({ isAllowed: true, window: { startMs: 0, bytes: 100 } });
  });
  test("the budget resets after the window", () => {
    expect(allowBytes({ startMs: 0, bytes: 100 }, 1500, 80, limit)).toEqual({ isAllowed: true, window: { startMs: 1500, bytes: 80 } });
  });
});

test.each([
  ["1.1.1.1", "10.0.0.5", "1.1.1.1"],
  ["9.9.9.9, 1.1.1.1", "10.0.0.5", "1.1.1.1"],
  [null, "127.0.0.1", "127.0.0.1"],
  [null, undefined, "unknown"],
])("readClientAddress trusts only the address the load balancer added (%p)", (forwardedFor, direct, expected) => {
  expect(readClientAddress(forwardedFor, direct)).toBe(expected);
});
