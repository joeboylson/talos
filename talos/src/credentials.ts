import { chmod, mkdir, rm } from "node:fs/promises";
import { parseJsonOrNull } from "talos-shared";
import { CREDENTIALS_FILE, CREDENTIALS_FILE_MODE, CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE } from "./constants";

export type Credentials = { serverUrl: string; machineKey: string };

// A key only works on the server that gave it out, so a key saved for a
// different server counts as no key.
export const pickMachineKey = (savedValue: unknown, serverUrl: string): string | null => {
  const isObject = typeof savedValue === "object" && savedValue !== null;
  if (!isObject) return null;
  const savedServerUrl: unknown = Reflect.get(savedValue, "serverUrl");
  const savedMachineKey: unknown = Reflect.get(savedValue, "machineKey");
  const isForThisServer = savedServerUrl === serverUrl && typeof savedMachineKey === "string";
  return isForThisServer ? savedMachineKey : null;
};

export const readMachineKey = async (serverUrl: string): Promise<string | null> => {
  const credentialsFile = Bun.file(CREDENTIALS_FILE);
  if (!(await credentialsFile.exists())) return null;
  return pickMachineKey(parseJsonOrNull(await credentialsFile.text()), serverUrl);
};

export const saveMachineKey = async (credentials: Credentials): Promise<void> => {
  await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  await Bun.write(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  await chmod(CREDENTIALS_FILE, CREDENTIALS_FILE_MODE);
};

export const forgetMachineKey = async (): Promise<void> => {
  await rm(CREDENTIALS_FILE, { force: true });
};
