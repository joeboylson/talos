import type { BunRequest } from "bun";
import type { MachineCheckResponse } from "talos-shared";
import type { Connections } from "./connections";
import { parseMachineKey } from "./machine-keys";
import type { MachineRecord, MachinesTable } from "./machines-table";
import type { RequestChecks } from "./request-checks";
import { hashSecret, isSameSecret } from "./utils/crypto";
import { textResponse } from "./utils/request";

export const createMachineRoutes = (machinesTable: MachinesTable, checks: RequestChecks, connections: Connections) => {
  const findMachineForRequest = async (request: Request): Promise<MachineRecord | null> => {
    const machineKey = parseMachineKey(request.headers.get("authorization"));
    if (!machineKey) return null;
    const machine = await machinesTable.findMachine(machineKey.machineId);
    if (!machine) return null;
    return isSameSecret(hashSecret(machineKey.secret), machine.keyHash) ? machine : null;
  };

  // talos calls this before connecting, so a removed machine knows to pair again.
  const check = async (request: Request): Promise<Response> => {
    const machine = await findMachineForRequest(request);
    if (!machine) return textResponse("Unknown machine key", 401);
    return Response.json({ machineName: machine.machineName } satisfies MachineCheckResponse);
  };

  const remove = async (request: BunRequest): Promise<Response> => {
    if (!checks.readTrustedLogin(request)) return textResponse("Not signed in", 401);
    const machineId = request.params.machineId;
    if (!machineId) return textResponse("Missing machine", 400);
    await machinesTable.removeMachine(machineId);
    connections.disconnectMachine(machineId);
    await connections.sendMachineListToAllPages();
    return new Response(null, { status: 204 });
  };

  return { findMachineForRequest, check, remove };
};
