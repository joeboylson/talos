import { chmod, rm } from "node:fs/promises";
import { parseJsonOrNull } from "talos-shared";
import { CREDENTIALS_FILE, CREDENTIALS_FILE_MODE } from "./constants";
import { claimTalosFolder, writePrivately } from "./talos-folder";

// machineName is the name the server gave this machine. Files saved before
// names existed have none until talos next connects.
export type Credentials = { serverUrl: string; machineKey: string; machineName: string | null };

// A key only works on the server that gave it out, so a key saved for a
// different server counts as no key.
export const pickCredentials = (savedValue: unknown, serverUrl: string): Credentials | null => {
  const isObject = typeof savedValue === "object" && savedValue !== null;
  if (!isObject) return null;
  const savedServerUrl: unknown = Reflect.get(savedValue, "serverUrl");
  const savedMachineKey: unknown = Reflect.get(savedValue, "machineKey");
  const savedMachineName: unknown = Reflect.get(savedValue, "machineName");
  const isForThisServer = savedServerUrl === serverUrl && typeof savedMachineKey === "string";
  if (!isForThisServer) return null;
  const machineName = typeof savedMachineName === "string" ? savedMachineName : null;
  return { serverUrl, machineKey: savedMachineKey, machineName };
};

export const readCredentials = async (serverUrl: string): Promise<Credentials | null> => {
  const credentialsFile = Bun.file(CREDENTIALS_FILE);
  if (!(await credentialsFile.exists())) return null;
  // A key saved before talos kept it private is closed now.
  await claimTalosFolder();
  await chmod(CREDENTIALS_FILE, CREDENTIALS_FILE_MODE);
  return pickCredentials(parseJsonOrNull(await credentialsFile.text()), serverUrl);
};

export const saveCredentials = (credentials: Credentials): Promise<void> => writePrivately(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));

export const forgetCredentials = async (): Promise<void> => {
  await rm(CREDENTIALS_FILE, { force: true });
};
