import {
  BEARER_PREFIX,
  ENV_KEYS,
  PAIR_POLL_INTERVAL_MS,
  SERVER_ROUTES,
  type Logger,
  type MachineCheckResponse,
  type PairCollectResponse,
  type PairPollResponse,
  type PairStartResponse,
} from "talos-shared";
import { rm } from "node:fs/promises";
import { WAITING_PAIRING_FILE } from "./constants";
import { forgetCredentials, readCredentials, saveCredentials } from "./credentials";
import { writePrivately } from "./talos-folder";

const postJson = async <T>(url: URL, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url.pathname} failed: ${response.status} ${await response.text()}`);
  // The server's reply shapes live in talos-shared, so both sides agree on them.
  return (await response.json()) as T;
};

// The name the server knows this machine by, or null if it no longer knows the key.
export const fetchMachineName = async (serverOrigin: string, machineKey: string, log: Logger): Promise<string | null> => {
  const response = await fetch(new URL(SERVER_ROUTES.machineCheck, serverOrigin), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });
  if (response.status === 401) {
    log.event("talos: the server doesn't know this machine's key any more; pairing again");
    return null;
  }
  if (!response.ok) throw new Error(`machine check failed: ${response.status}`);
  // Anything but a name (a proxy's page, another server) is a failed check to
  // try again, never a sign to throw the key away.
  const { machineName } = ((await response.json().catch(() => ({}))) ?? {}) as Partial<MachineCheckResponse>;
  if (typeof machineName !== "string" || !machineName) throw new Error("machine check: the reply had no machine name");
  log.detail(`talos: the server knows this machine as ${machineName}`);
  return machineName;
};

type PairedMachine = { machineKey: string; machineName: string };

// Whether the person who approved this machine is its owner. A talos running
// in the background can't ask, so it accepts only the GitHub login set in
// TALOS_PAIR_OWNER; one in a terminal asks.
const confirmApprover = async (approvedBy: string, expectedOwner: string | undefined, log: Logger): Promise<boolean> => {
  if (expectedOwner) return approvedBy.toLowerCase() === expectedOwner.trim().toLowerCase();
  if (!process.stdin.isTTY) {
    log.warn(`talos: can't ask whether ${approvedBy} is this machine's owner; set ${ENV_KEYS.pairOwner} to your GitHub login`);
    return false;
  }
  const answer = prompt(`talos: the code was entered by ${approvedBy}. Is that you? [y/N]`);
  return answer?.trim().toLowerCase() === "y";
};

// A code this machine is waiting on, saved so a talos started again (after a
// crash, Ctrl-C or a service restart) shows the same one: asking for another
// each time used up the server's few codes per address. Kept only for the same
// server and machine name, and only until it runs out.
export type WaitingPairing = { serverOrigin: string; machineName: string; pairingId: string; userCode: string; expiresAtMs: number };

export const pickWaitingPairing = (saved: unknown, serverOrigin: string, machineName: string, nowMs: number): WaitingPairing | null => {
  if (typeof saved !== "object" || saved === null) return null;
  const { pairingId, userCode, expiresAtMs } = saved as Partial<WaitingPairing>;
  const isWaiting =
    Reflect.get(saved, "serverOrigin") === serverOrigin &&
    Reflect.get(saved, "machineName") === machineName &&
    typeof pairingId === "string" &&
    typeof userCode === "string" &&
    typeof expiresAtMs === "number" &&
    expiresAtMs > nowMs;
  return isWaiting ? { serverOrigin, machineName, pairingId, userCode, expiresAtMs } : null;
};

const readWaitingPairing = async (serverOrigin: string, machineName: string): Promise<WaitingPairing | null> => {
  const saved = await Bun.file(WAITING_PAIRING_FILE)
    .json()
    .catch(() => null);
  return pickWaitingPairing(saved, serverOrigin, machineName, Date.now());
};
const forgetWaitingPairing = (): Promise<void> => rm(WAITING_PAIRING_FILE, { force: true });

const startPairing = async (serverOrigin: string, machineName: string): Promise<WaitingPairing> => {
  const started = await postJson<PairStartResponse>(new URL(SERVER_ROUTES.pairStart, serverOrigin), { machineName });
  const waiting = { serverOrigin, machineName, ...started };
  await writePrivately(WAITING_PAIRING_FILE, JSON.stringify(waiting));
  return waiting;
};

// Shows a code for its owner to type into the page (the one already waiting,
// if there is one), waits for someone to enter it, checks it was the owner,
// and only then collects the key. Starts over with a fresh code if this one
// runs out.
export const pairMachine = async (serverOrigin: string, machineName: string, log: Logger): Promise<PairedMachine> => {
  const { pairingId, userCode } = (await readWaitingPairing(serverOrigin, machineName)) ?? (await startPairing(serverOrigin, machineName));
  log.event(`\ntalos: this machine isn't paired yet.`);
  log.event(`talos: open ${serverOrigin}, sign in, and enter this code under "Pair a machine":\n`);
  log.event(`    ${userCode}\n`);

  const pollUrl = new URL(SERVER_ROUTES.pairPoll, serverOrigin);
  const waitForApproval = async (): Promise<string | null> => {
    await Bun.sleep(PAIR_POLL_INTERVAL_MS);
    const pollResult = await postJson<PairPollResponse>(pollUrl, { pairingId });
    if (pollResult.status === "approved") return pollResult.approvedBy;
    if (pollResult.status === "expired") return null;
    log.detail("talos: still waiting for the code to be entered");
    return waitForApproval();
  };

  const approvedBy = await waitForApproval();
  if (!approvedBy) {
    await forgetWaitingPairing();
    log.event("talos: that code ran out; here's a new one.");
    return pairMachine(serverOrigin, machineName, log);
  }
  // Entered by someone, so it's spent either way.
  await forgetWaitingPairing();
  if (!(await confirmApprover(approvedBy, process.env[ENV_KEYS.pairOwner], log))) {
    throw new Error(`talos: not pairing with ${approvedBy}. Someone else may have seen the code; start talos again for a new one`);
  }

  const collected = await postJson<PairCollectResponse>(new URL(SERVER_ROUTES.pairCollect, serverOrigin), { pairingId });
  log.event(`talos: paired as ${collected.machineName} for ${approvedBy}; saving this machine's key`);
  return collected;
};

// This machine's key and the server's name for it: the saved key if the
// server still knows it, else a new one from pairing. A saved key the server
// no longer knows (the machine was removed from the page) is thrown away.
export const acceptMachine = async (serverUrl: string, serverOrigin: string, wantedMachineName: string, log: Logger): Promise<PairedMachine> => {
  const savedCredentials = await readCredentials(serverUrl);
  const knownMachineName = savedCredentials && (await fetchMachineName(serverOrigin, savedCredentials.machineKey, log));
  if (savedCredentials && knownMachineName) {
    if (savedCredentials.machineName !== knownMachineName) await saveCredentials({ ...savedCredentials, machineName: knownMachineName });
    return { machineKey: savedCredentials.machineKey, machineName: knownMachineName };
  }
  if (savedCredentials) await forgetCredentials();
  const pairedMachine = await pairMachine(serverOrigin, wantedMachineName, log);
  await saveCredentials({ serverUrl, ...pairedMachine });
  return pairedMachine;
};
