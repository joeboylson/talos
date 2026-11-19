import type { BunRequest } from "bun";
import { LIMITS, pickUniqueName, toIdentifierName, type Logger, type MachineCheckResponse } from "talos-shared";
import type { Connections } from "./connections";
import { parseMachineKey } from "./machine-keys";
import type { MachineRecord, MachinesTable } from "./machines-table";
import type { RequestChecks } from "./request-checks";
import type { SessionPerson } from "./session";
import { hashSecret, isSameSecret } from "./utils/crypto";
import { readJsonBody, readStringField, textResponse } from "./utils/request";

// A new name for a machine: cleaned up like any name, and unique among the
// owner's other machines (its own current name doesn't count as taken).
export const chooseMachineName = (typedName: string, ownMachines: MachineRecord[], machineId: string): string => {
  const otherNames = ownMachines.filter((machine) => machine.machineId !== machineId).map((machine) => machine.machineName);
  return pickUniqueName(toIdentifierName(typedName), otherNames);
};

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
    const person = await checks.readTrustedPerson(request);
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

  type RenameRequest = { person: SessionPerson; machine: MachineRecord; typedName: string } | { response: Response };

  const readRenameRequest = async (request: BunRequest): Promise<RenameRequest> => {
    const person = await checks.readTrustedPerson(request);
    if (!person) return { response: textResponse("Not signed in", 401) };
    const machine = await machinesTable.findMachine(request.params.machineId ?? "");
    if (!machine || machine.ownerPersonId !== person.personId) return { response: textResponse("No such machine", 404) };
    const typedName = readStringField(await readJsonBody(request), "name");
    if (!typedName) return { response: textResponse("Missing name", 400) };
    // talos turns down a longer folder name, so say so here rather than accept it.
    if (typedName.length > LIMITS.maxNameTextLength) return { response: textResponse("That name is too long", 400) };
    return { person, machine, typedName };
  };

  const rename = async (request: BunRequest): Promise<Response> => {
    const renameRequest = await readRenameRequest(request);
    if ("response" in renameRequest) return renameRequest.response;
    const { person, machine, typedName } = renameRequest;

    const ownMachines = (await machinesTable.listMachines()).filter((candidate) => candidate.ownerPersonId === person.personId);
    const machineName = chooseMachineName(typedName, ownMachines, machine.machineId);
    await machinesTable.saveMachine({ ...machine, machineName });
    connections.renameConnectedMachine(machine.machineId, machineName);
    log.event(`${person.displayName} renamed "${machine.machineName}" to "${machineName}"`);
    await connections.sendMachineListToPages(person.personId);
    return Response.json({ name: machineName });
  };

  // The machine owns its folders, so the server only passes the rename on;
  // the machine's new folder list then updates the page.
  const renameFolder = async (request: BunRequest): Promise<Response> => {
    const renameRequest = await readRenameRequest(request);
    if ("response" in renameRequest) return renameRequest.response;
    const { person, machine, typedName } = renameRequest;
    const folderName = request.params.folderName ?? "";

    const isSent = connections.sendFolderRename(machine.machineId, folderName, typedName);
    if (!isSent) return textResponse(`${machine.machineName} is offline`, 409);
    log.event(`${person.displayName} asked "${machine.machineName}" to rename folder "${folderName}" to "${typedName}"`);
    return new Response(null, { status: 202 });
  };

  return { findMachineForRequest, check, remove, rename, renameFolder };
};
