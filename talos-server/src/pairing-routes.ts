import { randomUUID } from "node:crypto";
import {
  pickUniqueName,
  toIdentifierName,
  type Logger,
  type PairApproveResponse,
  type PairCollectResponse,
  type PairPollResponse,
  type PairStartResponse,
} from "talos-shared";
import {
  PAIRING_LIFETIME_MS,
} from "./constants";
import { createMachineKey, formatMachineKey } from "./machine-keys";
import type { MachinesTable } from "./machines-table";
import type { RequestChecks } from "./request-checks";
import { createUserCode, normalizeUserCode } from "./user-code";
import { hashSecret } from "./utils/crypto";
import { allowAttempt } from "./utils/rate-limit";
import { readJsonBody, readStringField, textResponse } from "./utils/request";
import { SERVER_LIMITS } from "./limits";


type Approver = { personId: string; displayName: string };

type WaitingPairing = {
  pairingId: string;
  userCode: string;
  machineName: string;
  expiresAtMs: number;
  approvedBy: Approver | null;
  clientAddress: string;
};

export const createPairingRoutes = (
  machinesTable: MachinesTable,
  checks: RequestChecks,
  onMachinePaired: (ownerPersonId: string) => Promise<void>,
  log: Logger,
) => {
  // Waiting pairings and recent attempts live only in memory. A restart just
  // means pairing again.
  let waitingPairings: WaitingPairing[] = [];
  const startTimesByAddress = new Map<string, number[]>();
  const approveTimesByPerson = new Map<string, number[]>();

  const dropExpiredPairings = (nowMs: number) => {
    waitingPairings = waitingPairings.filter((pairing) => pairing.expiresAtMs > nowMs);
  };

  const takeAttempt = (timesByKey: Map<string, number[]>, key: string, limit: typeof SERVER_LIMITS.pairStart): boolean => {
    const { isAllowed, timesMs } = allowAttempt(timesByKey.get(key) ?? [], Date.now(), limit);
    // Drop a key once its window empties, so a flood of distinct addresses can't
    // grow these maps without bound.
    if (timesMs.length === 0) timesByKey.delete(key);
    else timesByKey.set(key, timesMs);
    return isAllowed;
  };

  // Starting a pairing needs no sign-in (the machine has no key yet), so
  // each address gets a few at a time, and the whole server a fixed number.
  const start = async (request: Request, clientAddress: string): Promise<Response> => {
    if (!takeAttempt(startTimesByAddress, clientAddress, SERVER_LIMITS.pairStart)) {
      log.warn(`turned away pairing requests from ${clientAddress}: too many`);
      return textResponse("Too many pairing requests; wait a few minutes", 429);
    }
    const machineName = readStringField(await readJsonBody(request), "machineName");
    if (!machineName) return textResponse("Missing machineName", 400);
    if (machineName.length > SERVER_LIMITS.maxMachineNameLength) return textResponse("machineName is too long", 400);

    const nowMs = Date.now();
    dropExpiredPairings(nowMs);
    const waitingFromAddress = waitingPairings.filter((pairing) => pairing.clientAddress === clientAddress).length;
    if (waitingFromAddress >= SERVER_LIMITS.maxWaitingPairingsPerAddress) {
      log.warn(`turned away a pairing request from ${clientAddress}: it already has machines waiting`);
      return textResponse("Too many pairing requests; wait a few minutes", 429);
    }
    if (waitingPairings.length >= SERVER_LIMITS.maxWaitingPairings) {
      log.warn(`turned away a pairing request from "${toIdentifierName(machineName)}": ${SERVER_LIMITS.maxWaitingPairings} machines are already waiting`);
      return textResponse("Too many machines waiting", 429);
    }

    const pairing: WaitingPairing = {
      pairingId: randomUUID(),
      userCode: createUserCode(),
      machineName,
      expiresAtMs: nowMs + PAIRING_LIFETIME_MS,
      approvedBy: null,
      clientAddress,
    };
    waitingPairings = [...waitingPairings, pairing];
    // Never the code itself: anyone who can read the logs could use it.
    log.event(`machine "${toIdentifierName(machineName)}" asked to pair`);
    const { pairingId, userCode, expiresAtMs } = pairing;
    return Response.json({ pairingId, userCode, expiresAtMs } satisfies PairStartResponse);
  };

  const findWaitingPairing = async (request: Request): Promise<WaitingPairing | null> => {
    const pairingId = readStringField(await readJsonBody(request), "pairingId");
    dropExpiredPairings(Date.now());
    return waitingPairings.find((waitingPairing) => waitingPairing.pairingId === pairingId) ?? null;
  };

  const poll = async (request: Request): Promise<Response> => {
    const pairing = await findWaitingPairing(request);
    if (!pairing) return Response.json({ status: "expired" } satisfies PairPollResponse);
    if (!pairing.approvedBy) return Response.json({ status: "waiting" } satisfies PairPollResponse);
    return Response.json({ status: "approved", approvedBy: pairing.approvedBy.displayName } satisfies PairPollResponse);
  };

  // Approving only says who wants the machine. No key or machine exists until
  // the machine's own owner confirms, at the machine, that this is them.
  const approve = async (request: Request): Promise<Response> => {
    const person = await checks.readTrustedPerson(request);
    if (!person) return textResponse("Not signed in", 401);
    if (!takeAttempt(approveTimesByPerson, person.personId, SERVER_LIMITS.pairApprove)) {
      log.warn(`${person.displayName} entered too many pairing codes`);
      return textResponse("Too many codes entered; wait a few minutes", 429);
    }
    const typedCode = readStringField(await readJsonBody(request), "userCode");
    if (!typedCode) return textResponse("Missing userCode", 400);

    // Find and mark in one step, with nothing awaited in between, so two
    // people entering the same code can't both get it.
    dropExpiredPairings(Date.now());
    const userCode = normalizeUserCode(typedCode);
    const pairing = waitingPairings.find((waitingPairing) => waitingPairing.userCode === userCode && !waitingPairing.approvedBy);
    if (!pairing) {
      log.detail(`${person.displayName} entered a code no machine is waiting with`);
      return textResponse("No machine is waiting with that code", 404);
    }
    const approvedBy = { personId: person.personId, displayName: person.displayName };
    waitingPairings = waitingPairings.map((waitingPairing) =>
      waitingPairing === pairing ? { ...waitingPairing, approvedBy } : waitingPairing,
    );
    log.event(`${person.displayName} approved "${toIdentifierName(pairing.machineName)}"; waiting for the machine to confirm`);
    return Response.json({ machineName: toIdentifierName(pairing.machineName) } satisfies PairApproveResponse);
  };

  // The machine's owner confirmed at the machine: make the machine and its key,
  // once. Find AND remove the pairing in one synchronous step with nothing
  // awaited between (the body is read first), so two concurrent collects can't
  // both find the same pairing and each mint a key.
  const collect = async (request: Request): Promise<Response> => {
    const pairingId = readStringField(await readJsonBody(request), "pairingId");
    dropExpiredPairings(Date.now());
    const pairing = waitingPairings.find((waitingPairing) => waitingPairing.pairingId === pairingId) ?? null;
    const approvedBy = pairing?.approvedBy;
    if (!pairing || !approvedBy) return textResponse("No approved pairing", 404);
    waitingPairings = waitingPairings.filter((waitingPairing) => waitingPairing !== pairing);

    const ownMachineNames = (await machinesTable.listMachines())
      .filter((machine) => machine.ownerPersonId === approvedBy.personId)
      .map((machine) => machine.machineName);
    if (ownMachineNames.length >= SERVER_LIMITS.maxMachinesPerPerson) {
      log.warn(`${approvedBy.displayName} already has ${SERVER_LIMITS.maxMachinesPerPerson} machines; not adding another`);
      return textResponse(`A person can have at most ${SERVER_LIMITS.maxMachinesPerPerson} machines`, 409);
    }
    // The name is cleaned up for identifiers and made unique among that person's machines.
    const machineName = pickUniqueName(toIdentifierName(pairing.machineName), ownMachineNames);
    const machineKey = createMachineKey();
    await machinesTable.saveMachine({
      machineId: machineKey.machineId,
      machineName,
      ownerPersonId: approvedBy.personId,
      keyHash: hashSecret(machineKey.secret),
      pairedAtMs: Date.now(),
    });
    log.event(`"${machineName}" confirmed and now belongs to ${approvedBy.displayName}`);
    await onMachinePaired(approvedBy.personId);
    return Response.json({ machineKey: formatMachineKey(machineKey), machineName } satisfies PairCollectResponse);
  };

  return { start, poll, approve, collect };
};
