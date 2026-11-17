import type { BunRequest } from "bun";
import type { Logger, MachineCheckResponse } from "talos-shared";
import type { Connections } from "./connections";
import { parseMachineKey } from "./machine-keys";
import type { MachineRecord, MachinesTable } from "./machines-table";
import type { RequestChecks } from "./request-checks";
import { hashSecret, isSameSecret } from "./utils/crypto";
import { textResponse } from "./utils/request";

export const createMachineRoutes = (
  machinesTable: MachinesTable,
  checks: RequestChecks,
  connections: Connections,
  log: Logger,
) => {
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
    if (!machine) {
      log.event("a machine checked a key the server doesn't know (removed, or the emulator restarted); it will pair again");
      return textResponse("Unknown machine key", 401);
    }
    log.detail(`"${machine.machineName}" checked its key: ok`);
    return Response.json({ machineName: machine.machineName } satisfies MachineCheckResponse);
  };

  // Someone else's machine answers the same as one that doesn't exist, so
  // nobody can learn which machine ids are real.
  const remove = async (request: BunRequest): Promise<Response> => {
    const person = checks.readTrustedPerson(request);
    if (!person) return textResponse("Not signed in", 401);
    const machine = await machinesTable.findMachine(request.params.machineId ?? "");
    if (!machine || machine.ownerPersonId !== person.personId) {
      log.warn(`${person.displayName} tried to remove a machine that isn't theirs or doesn't exist`);
      return textResponse("No such machine", 404);
    }

    await machinesTable.removeMachine(machine.machineId);
    connections.disconnectMachine(machine.machineId);
    log.event(`${person.displayName} removed "${machine.machineName}"`);
    await connections.sendMachineListToPages(person.personId);
    return new Response(null, { status: 204 });
  };

  return { findMachineForRequest, check, remove };
};
