import { randomUUID } from "node:crypto";
import type { PairApproveResponse, PairPollResponse, PairStartResponse } from "talos-shared";
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
  onMachinePaired: () => Promise<void>,
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
    if (waitingPairings.length >= MAX_WAITING_PAIRINGS) return textResponse("Too many machines waiting", 429);

    const pairing: WaitingPairing = {
      pairingId: randomUUID(),
      userCode: createUserCode(),
      machineName,
      expiresAtMs: nowMs + PAIRING_LIFETIME_MS,
      approvedMachineKey: null,
    };
    waitingPairings = [...waitingPairings, pairing];
    const { pairingId, userCode, expiresAtMs } = pairing;
    return Response.json({ pairingId, userCode, expiresAtMs } satisfies PairStartResponse);
  };

  const poll = async (request: Request): Promise<Response> => {
    const pairingId = readStringField(await readJsonBody(request), "pairingId");
    dropExpiredPairings(Date.now());
    const pairing = waitingPairings.find((waitingPairing) => waitingPairing.pairingId === pairingId);
    if (!pairing) return Response.json({ status: "expired" } satisfies PairPollResponse);
    if (!pairing.approvedMachineKey) return Response.json({ status: "waiting" } satisfies PairPollResponse);

    // The key goes out once. After this, only the machine has it.
    waitingPairings = waitingPairings.filter((waitingPairing) => waitingPairing !== pairing);
    return Response.json({ status: "approved", machineKey: pairing.approvedMachineKey } satisfies PairPollResponse);
  };

  const approve = async (request: Request): Promise<Response> => {
    if (!checks.readTrustedLogin(request)) return textResponse("Not signed in", 401);
    const typedCode = readStringField(await readJsonBody(request), "userCode");
    if (!typedCode) return textResponse("Missing userCode", 400);

    const nowMs = Date.now();
    dropExpiredPairings(nowMs);
    const userCode = normalizeUserCode(typedCode);
    const pairing = waitingPairings.find(
      (waitingPairing) => waitingPairing.userCode === userCode && !waitingPairing.approvedMachineKey,
    );
    if (!pairing) return textResponse("No machine is waiting with that code", 404);

    const machineKey = createMachineKey();
    await machinesTable.saveMachine({
      machineId: machineKey.machineId,
      machineName: pairing.machineName,
      keyHash: hashSecret(machineKey.secret),
      pairedAtMs: nowMs,
    });
    const approvedMachineKey = formatMachineKey(machineKey);
    waitingPairings = waitingPairings.map((waitingPairing) =>
      waitingPairing === pairing ? { ...waitingPairing, approvedMachineKey } : waitingPairing,
    );
    await onMachinePaired();
    return Response.json({ machineName: pairing.machineName } satisfies PairApproveResponse);
  };

  return { start, poll, approve };
};
