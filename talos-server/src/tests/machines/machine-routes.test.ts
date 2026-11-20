import { describe, expect, test } from "bun:test";
import type { Connections } from "../../connections";
import { createMachineKey, formatMachineKey } from "../../machine-keys";
import { createMachineRoutes } from "../../machine-routes";
import type { MachineRecord, MachinesTable } from "../../machines-table";
import { createRequestChecks } from "../../request-checks";
import { hashSecret } from "../../utils/crypto";
import { fakeSignInsTable, personIdOf, quietLog, testConfig, testRequest } from "../helpers/fakes";

const JOE = 2;
const EVE = 3;
const joeKey = createMachineKey();

const setUp = () => {
  const machines: MachineRecord[] = [
    { machineId: joeKey.machineId, machineName: "work-mac", ownerPersonId: personIdOf(JOE), keyHash: hashSecret(joeKey.secret), pairedAtMs: 0 },
    { machineId: "eve-1", machineName: "spark", ownerPersonId: personIdOf(EVE), keyHash: "h", pairedAtMs: 0 },
  ];
  const changes: string[] = [];
  const table = {
    findMachine: async (machineId: string) => machines.find((machine) => machine.machineId === machineId) ?? null,
    listMachines: async () => machines,
    removeMachine: async (machineId: string) => void changes.push(`removed ${machineId}`),
    saveMachine: async (machine: MachineRecord) => void changes.push(`saved ${machine.machineId} as ${machine.machineName}`),
  } as unknown as MachinesTable;
  const connections = {
    disconnectMachine: () => {},
    renameConnectedMachine: () => {},
    sendFolderRename: (machineId: string) => (changes.push(`folder rename sent to ${machineId}`), true),
    sendMachineListToPages: async () => {},
  } as unknown as Connections;
  const checks = createRequestChecks(testConfig, fakeSignInsTable([JOE, EVE]).table);
  return { routes: createMachineRoutes(table, checks, connections, quietLog), changes };
};

const bearer = (machineId: string, secret: string) =>
  new Request("https://talos.test", { headers: { authorization: `Bearer ${formatMachineKey({ machineId, secret })}` } });

describe("machine keys", () => {
  test("a key with its own secret finds its machine", async () => {
    expect((await setUp().routes.findMachineForRequest(bearer(joeKey.machineId, joeKey.secret)))?.machineName).toBe("work-mac");
  });

  test("a known machine id with the wrong secret gets nothing", async () => {
    expect(await setUp().routes.findMachineForRequest(bearer(joeKey.machineId, "not-the-secret"))).toBeNull();
  });
});

describe("someone else's machine", () => {
  const joesMachine = { machineId: joeKey.machineId, folderName: "talos" };

  test.each(["remove", "rename", "renameFolder"] as const)("Eve can't %s on Joe's machine", async (route) => {
    const { routes, changes } = setUp();
    const response = await routes[route](testRequest({ method: "PATCH", githubId: EVE, params: joesMachine, body: { name: "mine-now" } }));
    expect(response.status).toBe(404);
    expect(changes).toEqual([]);
  });

  test.each(["remove", "rename", "renameFolder"] as const)("Joe can %s on his own machine", async (route) => {
    const { routes, changes } = setUp();
    const response = await routes[route](testRequest({ method: "PATCH", githubId: JOE, params: joesMachine, body: { name: "home-mac" } }));
    expect(response.status).toBeLessThan(300);
    expect(changes.length).toBe(1);
  });

  test("a new name only has to be unique among the owner's own machines", async () => {
    const { routes } = setUp();
    const response = await routes.rename(testRequest({ method: "PATCH", githubId: JOE, params: joesMachine, body: { name: "spark" } }));
    expect(await response.json()).toEqual({ name: "spark" });
  });
});
