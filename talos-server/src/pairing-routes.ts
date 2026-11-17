import { randomUUID } from "node:crypto";
import {
  pickUniqueName,
  toIdentifierName,
  type Logger,
  type PairApproveResponse,
  type PairPollResponse,
  type PairStartResponse,
} from "talos-shared";
import { MAX_WAITING_PAIRINGS, PAIRING_LIFETIME_MS } from "./constants";
import { createMachineKey, formatMachineKey } from "./machine-keys";
import type { MachinesTable } from "./machines-table";
import type { RequestChecks } from "./request-checks";
import { createUserCode, normalizeUserCode } from "./user-code";
import { hashSecret } from "./utils/crypto";
import { readJsonBody, readStringField, textResponse } from "./utils/request";

const MAX_MACHINE_NAME_LENGTH = 64;

type WaitingPairing = {
  pairingId: string;
  userCode: string;
  machineName: string;
  expiresAtMs: number;
  approvedMachineKey: string | null;
};

export const createPairingRoutes = (
  machinesTable: MachinesTable,
  checks: RequestChecks,
  onMachinePaired: (ownerPersonId: string) => Promise<void>,
  log: Logger,
) => {
  // Waiting pairings live only in memory. A restart just means pairing again.
  let waitingPairings: WaitingPairing[] = [];

  const dropExpiredPairings = (nowMs: number) => {
    waitingPairings = waitingPairings.filter((pairing) => pairing.expiresAtMs > nowMs);
  };

  const start = async (request: Request): Promise<Response> => {
    const machineName = readStringField(await readJsonBody(request), "machineName");
    if (!machineName) return textResponse("Missing machineName", 400);
    if (machineName.length > MAX_MACHINE_NAME_LENGTH) return textResponse("machineName is too long", 400);

    const nowMs = Date.now();
    dropExpiredPairings(nowMs);
    if (waitingPairings.length >= MAX_WAITING_PAIRINGS) {
      log.warn(`turned away a pairing request from "${machineName}": ${MAX_WAITING_PAIRINGS} machines are already waiting`);
      return textResponse("Too many machines waiting", 429);
    }

    const pairing: WaitingPairing = {
      pairingId: randomUUID(),
      userCode: createUserCode(),
      machineName,
      expiresAtMs: nowMs + PAIRING_LIFETIME_MS,
      approvedMachineKey: null,
    };
    waitingPairings = [...waitingPairings, pairing];
    log.event(`machine "${machineName}" asked to pair; its code is ${pairing.userCode}`);
    const { pairingId, userCode, expiresAtMs } = pairing;
    return Response.json({ pairingId, userCode, expiresAtMs } satisfies PairStartResponse);
  };

  const poll = async (request: Request): Promise<Response> => {
    const pairingId = readStringField(await readJsonBody(request), "pairingId");
    dropExpiredPairings(Date.now());
    const pairing = waitingPairings.find((waitingPairing) => waitingPairing.pairingId === pairingId);
    if (!pairing) {
      log.detail("a machine checked on a pairing that ran out");
      return Response.json({ status: "expired" } satisfies PairPollResponse);
    }
    if (!pairing.approvedMachineKey) {
      log.detail(`"${pairing.machineName}" is still waiting for its code to be entered`);
      return Response.json({ status: "waiting" } satisfies PairPollResponse);
    }

    // The key goes out once. After this, only the machine has it.
    waitingPairings = waitingPairings.filter((waitingPairing) => waitingPairing !== pairing);
    log.event(`"${pairing.machineName}" collected its key`);
    return Response.json({ status: "approved", machineKey: pairing.approvedMachineKey } satisfies PairPollResponse);
  };

  const approve = async (request: Request): Promise<Response> => {
    const person = checks.readTrustedPerson(request);
    if (!person) return textResponse("Not signed in", 401);
    const typedCode = readStringField(await readJsonBody(request), "userCode");
    if (!typedCode) return textResponse("Missing userCode", 400);

    const nowMs = Date.now();
    dropExpiredPairings(nowMs);
    const userCode = normalizeUserCode(typedCode);
    const pairing = waitingPairings.find(
      (waitingPairing) => waitingPairing.userCode === userCode && !waitingPairing.approvedMachineKey,
    );
    if (!pairing) {
      log.detail(`${person.displayName} entered ${userCode}, but no machine is waiting with that code`);
      return textResponse("No machine is waiting with that code", 404);
    }

    // Whoever approves the code owns the machine. Its name is cleaned up for
    // identifiers and made unique among that person's machines.
    const ownMachineNames = (await machinesTable.listMachines())
      .filter((machine) => machine.ownerPersonId === person.personId)
      .map((machine) => machine.machineName);
    const machineName = pickUniqueName(toIdentifierName(pairing.machineName), ownMachineNames);
    const machineKey = createMachineKey();
    await machinesTable.saveMachine({
      machineId: machineKey.machineId,
      machineName,
      ownerPersonId: person.personId,
      keyHash: hashSecret(machineKey.secret),
      pairedAtMs: nowMs,
    });
    const approvedMachineKey = formatMachineKey(machineKey);
    waitingPairings = waitingPairings.map((waitingPairing) =>
      waitingPairing === pairing ? { ...waitingPairing, approvedMachineKey } : waitingPairing,
    );
    log.event(`${person.displayName} approved "${machineName}"; it now belongs to them`);
    await onMachinePaired(person.personId);
    return Response.json({ machineName } satisfies PairApproveResponse);
  };

  return { start, poll, approve };
};
