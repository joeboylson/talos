import { afterEach, expect, setSystemTime, test } from "bun:test";
import fc from "fast-check";
import { quietLog } from "../helpers/fakes";
import { PAIRING_LIFETIME_MS } from "../../constants";
import type { MachineRecord, MachinesTable } from "../../machines-table";
import { createPairingRoutes } from "../../pairing-routes";
import type { RequestChecks } from "../../request-checks";

// Rules: a pairing code is approved at most once, never at or after it
// expires; a key is collected at most once, only after approval and before
// expiry; and the machine belongs to whoever approved it.

const PEOPLE = ["p0", "p1", "p2", "p3"];
const START_MS = Date.UTC(2026, 0, 1);

afterEach(() => setSystemTime());

// Ways a person might type a code: as shown, lowercase, no dash, spaced.
const typeCode = (code: string, style: number): string =>
  [code, code.toLowerCase(), code.replace("-", ""), ` ${code.split("").join(" ")} `][style] ?? code;

const action = fc.oneof(
  fc.record({ kind: fc.constant("start" as const), address: fc.nat({ max: 5 }) }),
  fc.record({ kind: fc.constant("approve" as const), person: fc.nat({ max: PEOPLE.length - 1 }), pairing: fc.nat(), style: fc.nat({ max: 3 }) }),
  fc.record({ kind: fc.constant("poll" as const), pairing: fc.nat() }),
  fc.record({ kind: fc.constant("collect" as const), pairing: fc.nat() }),
  fc.record({ kind: fc.constant("wait" as const), ms: fc.oneof(fc.nat({ max: 1000 }), fc.constant(PAIRING_LIFETIME_MS), fc.integer({ min: PAIRING_LIFETIME_MS - 1000, max: PAIRING_LIFETIME_MS + 1000 })) }),
);

type Action = typeof action extends fc.Arbitrary<infer T> ? T : never;

type Known = { pairingId: string; userCode: string; expiresAtMs: number; approvedBy: string | null; collected: number; approvals: number };

const runScenario = async (actions: Action[]) => {
  let nowMs = START_MS;
  setSystemTime(new Date(nowMs));
  const saved: MachineRecord[] = [];
  const machinesTable = {
    listMachines: async () => saved,
    saveMachine: async (machine: MachineRecord) => void saved.push(machine),
  } as unknown as MachinesTable;
  const checks = {
    readTrustedPerson: async (request: Request) => {
      const personId = request.headers.get("x-test-person");
      return personId ? { personId, signInId: `github-id:${personId}`, displayName: personId, expiresAtMs: Infinity } : null;
    },
  } as unknown as RequestChecks;
  const routes = createPairingRoutes(machinesTable, checks, async () => {}, quietLog);
  const post = (body: unknown, personId?: string) =>
    new Request("https://talos.test", { method: "POST", body: JSON.stringify(body), headers: personId ? { "x-test-person": personId } : {} });
  const known: Known[] = [];
  const pickKnown = (index: number) => known[index % Math.max(1, known.length)];

  for (const step of actions) {
    if (step.kind === "wait") {
      nowMs += step.ms;
      setSystemTime(new Date(nowMs));
    } else if (step.kind === "start") {
      const response = await routes.start(post({ machineName: "atlas" }), `10.0.0.${step.address}`);
      if (response.status === 200) {
        const body = (await response.json()) as { pairingId: string; userCode: string; expiresAtMs: number };
        known.push({ ...body, approvedBy: null, collected: 0, approvals: 0 });
      }
    } else if (step.kind === "approve") {
      const pairing = pickKnown(step.pairing);
      if (!pairing) continue;
      const personId = PEOPLE[step.person] ?? "p0";
      const isOpen = nowMs < pairing.expiresAtMs && pairing.approvedBy === null;
      const response = await routes.approve(post({ userCode: typeCode(pairing.userCode, step.style) }, personId));
      // A live, unapproved code works however it's typed (unless the person hit the rate limit).
      if (isOpen) expect([200, 429]).toContain(response.status);
      if (response.status === 200) {
        pairing.approvals += 1;
        expect(pairing.approvals).toBe(1);
        expect(nowMs).toBeLessThan(pairing.expiresAtMs);
        expect(pairing.collected).toBe(0);
        pairing.approvedBy = personId;
      }
    } else if (step.kind === "poll") {
      const pairing = pickKnown(step.pairing);
      if (!pairing) continue;
      const body = (await (await routes.poll(post({ pairingId: pairing.pairingId }))).json()) as { status: string };
      if (body.status === "approved") expect(pairing.approvedBy).not.toBeNull();
      if (nowMs >= pairing.expiresAtMs) expect(body.status).toBe("expired");
    } else {
      const pairing = pickKnown(step.pairing);
      if (!pairing) continue;
      const savedBefore = saved.length;
      const response = await routes.collect(post({ pairingId: pairing.pairingId }));
      if (response.status === 200) {
        pairing.collected += 1;
        expect(pairing.collected).toBe(1);
        expect(pairing.approvedBy).not.toBeNull();
        expect(nowMs).toBeLessThan(pairing.expiresAtMs);
        expect(saved.length).toBe(savedBefore + 1);
        expect(saved.at(-1)?.ownerPersonId).toBe(pairing.approvedBy ?? "nobody");
      } else {
        expect(saved.length).toBe(savedBefore);
      }
    }
  }
};

test("rule: a code is approved once, never after expiry, and the key goes once to the approver", async () => {
  await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 40, size: "max" }), runScenario), {
    seed: 20261121,
    numRuns: 400,
  });
}, 60_000);
