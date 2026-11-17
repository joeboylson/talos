import { randomUUID } from "node:crypto";
import { BEARER_PREFIX } from "talos-shared";
import { createRandomSecret } from "./utils/crypto";

// A machine key is "<machineId>.<secret>". The server stores only a hash of
// the secret, so a leaked table can't be used to connect.
export type MachineKey = { machineId: string; secret: string };

export const createMachineKey = (): MachineKey => ({ machineId: randomUUID(), secret: createRandomSecret() });

export const formatMachineKey = ({ machineId, secret }: MachineKey): string => `${machineId}.${secret}`;

export const parseMachineKey = (authorizationHeader: string | null): MachineKey | null => {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return null;
  const [machineId, secret, ...extraParts] = authorizationHeader.slice(BEARER_PREFIX.length).split(".");
  if (!machineId || !secret || extraParts.length > 0) return null;
  return { machineId, secret };
};
