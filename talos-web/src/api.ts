import {
  SERVER_ROUTES,
  type CurrentUserResponse,
  type PairApproveResponse,
  type Settings,
} from "talos-shared";

const sendJson = (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Null means nobody is signed in; anything else unexpected fails loudly.
export const fetchCurrentUser = async (): Promise<CurrentUserResponse | null> => {
  const response = await fetch(SERVER_ROUTES.currentUser);
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`couldn't load who's signed in: ${response.status}`);
  return (await response.json()) as CurrentUserResponse;
};

export const signOut = async (): Promise<void> => {
  await fetch(SERVER_ROUTES.signOut, { method: "POST" });
};

// Returns the paired machine's name, or the server's reason it didn't pair.
export const approvePairing = async (userCode: string): Promise<{ machineName: string } | { problem: string }> => {
  const response = await sendJson(SERVER_ROUTES.pairApprove, "POST", { userCode });
  if (!response.ok) return { problem: await response.text() };
  return (await response.json()) as PairApproveResponse;
};

export const removeMachine = async (machineId: string): Promise<void> => {
  const response = await fetch(`${SERVER_ROUTES.machines}/${encodeURIComponent(machineId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`couldn't remove the machine: ${response.status}`);
};

export const fetchSettings = async (): Promise<Settings> => {
  const response = await fetch(SERVER_ROUTES.settings);
  if (!response.ok) throw new Error(`couldn't load settings: ${response.status}`);
  return (await response.json()) as Settings;
};

export const saveSettings = async (settings: Settings): Promise<Settings> => {
  const response = await sendJson(SERVER_ROUTES.settings, "PUT", settings);
  if (!response.ok) throw new Error(`couldn't save settings: ${response.status}`);
  return (await response.json()) as Settings;
};
