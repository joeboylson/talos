import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Connections } from "../../connections";
import { createMachineKey, formatMachineKey } from "../../machine-keys";
import { createMachineRoutes } from "../../machine-routes";
import type { MachineRecord, MachinesTable } from "../../machines-table";
import { createRequestChecks, isClaimStillValid } from "../../request-checks";
import { createSettingsRoutes } from "../../settings-routes";
import type { SettingsTable } from "../../settings-table";
import { hashSecret } from "../../utils/crypto";
import {
  ADMIN_GITHUB_ID,
  OTHER_ORIGIN,
  TEST_ORIGIN,
  fakeSignInsTable,
  personIdOf,
  quietLog,
  sessionCookieFor,
  signInOf,
  testConfig,
  testRequest,
} from "../helpers/fakes";

// Rules: whatever machines and owners exist, a person can only remove, rename
// or rename folders on their own machines; a machine key works only with its
// own secret; only the admin reads or changes settings; and signing out ends
// every session made at or before it.

const PEOPLE = [ADMIN_GITHUB_ID, 2, 3, 4];
const fakeSignIns = (signOutCounts?: Map<string, number>) => fakeSignInsTable(PEOPLE, signOutCounts).table;
const config = testConfig;
const ORIGIN = TEST_ORIGIN;

const request = (method: string, githubId: number | null, params: Record<string, string>, body?: unknown, origin: string | null = ORIGIN) =>
  testRequest({ method, githubId, params, body, origin });

test("rule: a person can only remove, rename or rename folders on their own machines", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...PEOPLE), { minLength: 1, maxLength: 6 }),
      fc.array(
        fc.record({
          person: fc.option(fc.constantFrom(...PEOPLE)),
          machine: fc.nat(),
          route: fc.constantFrom("remove", "rename", "renameFolder"),
          fromOwnPage: fc.boolean(),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      async (owners, calls) => {
        const machines: MachineRecord[] = owners.map((owner, index) => ({
          machineId: `m${index}`, machineName: `name-${index}`, ownerPersonId: personIdOf(owner), keyHash: "h", pairedAtMs: 0,
        }));
        const touched: string[] = [];
        const table = {
          findMachine: async (machineId: string) => machines.find((machine) => machine.machineId === machineId) ?? null,
          listMachines: async () => machines,
          removeMachine: async (machineId: string) => void touched.push(machineId),
          saveMachine: async (machine: MachineRecord) => void touched.push(machine.machineId),
        } as unknown as MachinesTable;
        const connections = {
          disconnectMachine: (machineId: string) => touched.push(machineId),
          renameConnectedMachine: (machineId: string) => touched.push(machineId),
          sendFolderRename: (machineId: string) => (touched.push(machineId), true),
          sendMachineListToPages: async () => {},
        } as unknown as Connections;
        const routes = createMachineRoutes(table, createRequestChecks(config, fakeSignIns()), connections, quietLog);

        for (const call of calls) {
          const target = machines[call.machine % machines.length];
          if (!target) continue;
          touched.length = 0;
          const params = { machineId: target.machineId, folderName: "talos" };
          const response = await routes[call.route](request("PATCH", call.person, params, { name: "new-name" }, call.fromOwnPage ? ORIGIN : OTHER_ORIGIN));
          const isAllowed = call.person !== null && call.fromOwnPage && personIdOf(call.person) === target.ownerPersonId;
          expect({ status: response.status < 300, touched: touched.length > 0 }).toEqual({ status: isAllowed, touched: isAllowed });
          expect(touched.every((machineId) => machineId === target.machineId)).toBe(true);
        }
      },
    ),
    { seed: 20261124, numRuns: 300 },
  );
});

test("rule: a machine key gets in only with its own secret", async () => {
  await fc.assert(
    fc.asyncProperty(fc.nat({ max: 4 }), fc.nat({ max: 4 }), fc.boolean(), async (keyIndex, machineIndex, useOwnSecret) => {
      const keys = Array.from({ length: 5 }, () => createMachineKey());
      const machines = keys.map((key, index) => ({ machineId: key.machineId, machineName: `m${index}`, ownerPersonId: "p", keyHash: hashSecret(key.secret), pairedAtMs: 0 }));
      const table = { findMachine: async (machineId: string) => machines.find((machine) => machine.machineId === machineId) ?? null } as unknown as MachinesTable;
      const routes = createMachineRoutes(table, {} as never, {} as never, quietLog);
      const secretFrom = keys[useOwnSecret ? machineIndex : keyIndex];
      const machineKey = { machineId: keys[machineIndex]?.machineId ?? "", secret: secretFrom?.secret ?? "" };
      const found = await routes.findMachineForRequest(new Request(ORIGIN, { headers: { authorization: `Bearer ${formatMachineKey(machineKey)}` } }));
      const isRightSecret = useOwnSecret || keyIndex === machineIndex;
      expect(found?.machineId ?? null).toBe(isRightSecret ? machineKey.machineId : null);
    }),
    { seed: 20261125, numRuns: 200 },
  );
});

test("rule: only the admin reads or changes settings", async () => {
  await fc.assert(
    fc.asyncProperty(fc.option(fc.constantFrom(...PEOPLE)), fc.boolean(), fc.boolean(), async (githubId, fromOwnPage, allowNewPeople) => {
      const saved: unknown[] = [];
      const settingsTable = { readSettings: async () => ({ allowNewPeople: false }), saveSettings: async (settings: unknown) => void saved.push(settings) } as unknown as SettingsTable;
      const routes = createSettingsRoutes(createRequestChecks(config, fakeSignIns()), settingsTable, quietLog);
      const origin = fromOwnPage ? ORIGIN : OTHER_ORIGIN;
      const isAdmin = githubId === ADMIN_GITHUB_ID;
      const readResponse = await routes.read(request("GET", githubId, {}, undefined, origin));
      expect(readResponse.status === 200).toBe(isAdmin);
      const updateResponse = await routes.update(request("PUT", githubId, {}, { allowNewPeople }, origin));
      expect(updateResponse.status === 200).toBe(isAdmin && fromOwnPage);
      expect(saved.length).toBe(isAdmin && fromOwnPage ? 1 : 0);
    }),
    { seed: 20261126, numRuns: 200 },
  );
});

test("rule: a session counts only under its sign-in's current sign-out count, whatever the times", () => {
  fc.assert(
    fc.property(fc.nat(5), fc.nat(5), fc.integer(), (cookieCount, recordCount, issuedAtMs) => {
      const signIn = signInOf(2);
      const claim = { personId: signIn.personId, signInId: signIn.signInId, displayName: "u2", issuedAtMs, expiresAtMs: Infinity, signOutCount: cookieCount };
      const record = recordCount === 0 ? signIn : { ...signIn, signOutCount: recordCount };
      expect(isClaimStillValid(claim, record)).toBe(cookieCount === recordCount);
      expect(isClaimStillValid({ ...claim, personId: "someone-else" }, record)).toBe(false);
    }),
    { seed: 20261127, numRuns: 1000 },
  );
});

test("rule: a signed-in request counts only while its sign-in hasn't been signed out since", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...PEOPLE), fc.integer({ min: -5000, max: 5000 }), async (githubId, issuedOffsetMs) => {
      const recordCount = Math.abs(issuedOffsetMs) % 3;
      const cookieCount = (Math.abs(issuedOffsetMs) >> 2) % 3;
      const checks = createRequestChecks(config, fakeSignIns(new Map([[signInOf(githubId).signInId, recordCount]])));
      const headers = { cookie: sessionCookieFor(githubId, cookieCount), origin: ORIGIN };
      const person = await checks.readSignedInPerson(new Request(ORIGIN, { headers }));
      expect(person?.personId ?? null).toBe(cookieCount === recordCount ? personIdOf(githubId) : null);
    }),
    { seed: 20261128, numRuns: 300 },
  );
});
