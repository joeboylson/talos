import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { SERVER_ROUTES } from "talos-shared";
import { createAuthRoutes } from "../../auth-routes";
import { createConnections, type SocketData } from "../../connections";
import { HEALTH_ROUTE } from "../../constants";
import { createMachineKey, formatMachineKey } from "../../machine-keys";
import { createMachineRoutes } from "../../machine-routes";
import type { MachineRecord, MachinesTable } from "../../machines-table";
import { createPairingRoutes } from "../../pairing-routes";
import { createRequestChecks } from "../../request-checks";
import { buildSecurityHeaders } from "../../security-headers";
import { buildApiRoutes, decideSocket, type RouteHandler } from "../../server-routes";
import { createSettingsRoutes } from "../../settings-routes";
import type { SettingsTable } from "../../settings-table";
import { hashSecret } from "../../utils/crypto";
import { ADMIN_GITHUB_ID, OTHER_ORIGIN, fakeSignInsTable, personIdOf, quietLog, testConfig, testRequest } from "../helpers/fakes";

const JOE = 2;
const joeKey = createMachineKey();
const joesMachine: MachineRecord = { machineId: joeKey.machineId, machineName: "work-mac", ownerPersonId: personIdOf(JOE), keyHash: hashSecret(joeKey.secret), pairedAtMs: 0 };
const machinesTable = {
  findMachine: async (machineId: string) => (machineId === joesMachine.machineId ? joesMachine : null),
  listMachines: async () => [joesMachine],
  removeMachine: async () => {},
  saveMachine: async () => {},
} as unknown as MachinesTable;
const settingsTable = { readSettings: async () => ({ allowNewPeople: false }), saveSettings: async () => {} } as unknown as SettingsTable;
const signIns = fakeSignInsTable([ADMIN_GITHUB_ID, JOE]).table;
const checks = createRequestChecks(testConfig, signIns);
const connections = createConnections(machinesTable, quietLog);
const machineRoutes = createMachineRoutes(machinesTable, checks, connections, quietLog);
const securityHeaders = buildSecurityHeaders(true);
const apiRoutes = buildApiRoutes({
  authRoutes: createAuthRoutes(testConfig, checks, { signInsTable: signIns, settingsTable }, connections.disconnectPersonPages, quietLog),
  settingsRoutes: createSettingsRoutes(checks, settingsTable, quietLog),
  machineRoutes,
  pairingRoutes: createPairingRoutes(machinesTable, checks, connections.sendMachineListToPages, quietLog),
  securityHeaders,
});
const fakeServer = { requestIP: () => ({ address: "1.2.3.4" }) } as unknown as Server<SocketData>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const handlerFor = (path: string, method: Method): RouteHandler | undefined => {
  const route: unknown = Reflect.get(apiRoutes, path);
  if (typeof route === "function") return route as RouteHandler;
  return route && typeof route === "object" ? (Reflect.get(route, method) as RouteHandler | undefined) : undefined;
};
const call = async (path: string, method: Method, request = testRequest({ method })) => {
  const handler = handlerFor(path, method);
  if (!handler) throw new Error(`no ${method} ${path}`);
  return handler(request, fakeServer);
};

const machinePath = `${SERVER_ROUTES.machines}/:machineId`;
const folderPath = `${SERVER_ROUTES.machines}/:machineId/folders/:folderName`;

describe("the route table", () => {
  test("each path answers only its own methods", () => {
    const methodsByPath = Object.fromEntries(
      Object.entries(apiRoutes).map(([path, route]) => [path, typeof route === "function" ? "any" : Object.keys(route).sort().join(",")]),
    );
    expect(methodsByPath).toEqual({
      [HEALTH_ROUTE]: "any",
      [SERVER_ROUTES.signIn]: "GET",
      [SERVER_ROUTES.signInCallback]: "GET",
      [SERVER_ROUTES.signOut]: "POST",
      [SERVER_ROUTES.currentUser]: "GET",
      [SERVER_ROUTES.settings]: "GET,PUT",
      [SERVER_ROUTES.pairStart]: "POST",
      [SERVER_ROUTES.pairPoll]: "POST",
      [SERVER_ROUTES.pairApprove]: "POST",
      [SERVER_ROUTES.pairCollect]: "POST",
      [SERVER_ROUTES.machineCheck]: "GET",
      [machinePath]: "DELETE,PATCH",
      [folderPath]: "PATCH",
    });
  });

  test.each([
    ["sign-out", SERVER_ROUTES.signOut, "POST", 401],
    ["approving a pairing", SERVER_ROUTES.pairApprove, "POST", 401],
    ["removing a machine", machinePath, "DELETE", 401],
    ["renaming a machine", machinePath, "PATCH", 401],
    ["renaming a folder", folderPath, "PATCH", 401],
    ["changing settings", SERVER_ROUTES.settings, "PUT", 403],
  ] as const)("%s from another site is refused, even with Joe's cookie", async (_label, path, method, status) => {
    const request = testRequest({ method, githubId: JOE, origin: OTHER_ORIGIN, params: { machineId: joesMachine.machineId, folderName: "talos" }, body: { name: "x", userCode: "AAAA-AAAA", allowNewPeople: true } });
    expect((await call(path, method, request)).status).toBe(status);
  });

  test("Joe's own requests reach the right handlers", async () => {
    const params = { machineId: joesMachine.machineId };
    const renamed = await call(machinePath, "PATCH", testRequest({ method: "PATCH", githubId: JOE, params, body: { name: "home-mac" } }));
    expect(await renamed.json()).toEqual({ name: "home-mac" });
    expect((await call(machinePath, "DELETE", testRequest({ method: "DELETE", githubId: JOE, params }))).status).toBe(204);
  });

  test("reading settings is the admin's only", async () => {
    expect((await call(SERVER_ROUTES.settings, "GET", testRequest({ githubId: JOE }))).status).toBe(403);
    expect((await call(SERVER_ROUTES.settings, "GET", testRequest({ githubId: ADMIN_GITHUB_ID }))).status).toBe(200);
  });

  test("every answer carries the security headers", async () => {
    const response = await call(HEALTH_ROUTE, "GET");
    Object.entries(securityHeaders).forEach(([name, value]) => expect(response.headers.get(name)).toBe(value));
  });
});

describe("who a socket belongs to", () => {
  const socketRequest = (path: string, headers: Record<string, string>) => new Request(`https://talos.test${path}`, { headers });

  test("a page socket belongs to the person whose session opened it, whatever the request says", async () => {
    const request = testRequest({ path: `${SERVER_ROUTES.pageSocket}?as=${personIdOf(ADMIN_GITHUB_ID)}`, githubId: JOE });
    const decision = await decideSocket(request, checks, machineRoutes, quietLog);
    expect(decision && "data" in decision ? decision.data : null).toMatchObject({ role: "page", personId: personIdOf(JOE) });
  });

  test("a page socket opened from another site, or with no session, is refused", async () => {
    const fromOtherSite = await decideSocket(testRequest({ path: SERVER_ROUTES.pageSocket, githubId: JOE, origin: OTHER_ORIGIN }), checks, machineRoutes, quietLog);
    const signedOut = await decideSocket(testRequest({ path: SERVER_ROUTES.pageSocket }), checks, machineRoutes, quietLog);
    expect([fromOtherSite, signedOut].map((decision) => (decision && "response" in decision ? decision.response.status : null))).toEqual([401, 401]);
  });

  test("a machine socket gets its machine and owner from the key's record, nothing else", async () => {
    const request = socketRequest(SERVER_ROUTES.machineSocket, { authorization: `Bearer ${formatMachineKey(joeKey)}`, "x-owner": "eve" });
    const decision = await decideSocket(request, checks, machineRoutes, quietLog);
    expect(decision && "data" in decision ? decision.data : null).toEqual({
      role: "machine", machineId: joesMachine.machineId, machineName: "work-mac", ownerPersonId: personIdOf(JOE),
    });
  });

  test("a machine socket with an unknown key is refused", async () => {
    const request = socketRequest(SERVER_ROUTES.machineSocket, { authorization: `Bearer ${formatMachineKey({ ...joeKey, secret: "wrong" })}` });
    const decision = await decideSocket(request, checks, machineRoutes, quietLog);
    expect(decision && "response" in decision ? decision.response.status : null).toBe(401);
  });

  test("any other path isn't a socket", async () => {
    expect(await decideSocket(socketRequest("/elsewhere", {}), checks, machineRoutes, quietLog)).toBeNull();
  });
});
