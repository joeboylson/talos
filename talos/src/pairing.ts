import {
  BEARER_PREFIX,
  PAIR_POLL_INTERVAL_MS,
  SERVER_ROUTES,
  type Logger,
  type MachineCheckResponse,
  type PairPollResponse,
  type PairStartResponse,
} from "talos-shared";

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

export const isMachineKeyAccepted = async (serverOrigin: string, machineKey: string, log: Logger): Promise<boolean> => {
  const response = await fetch(new URL(SERVER_ROUTES.machineCheck, serverOrigin), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });
  if (response.status === 401) {
    log.event("talos: the server doesn't know this machine's key any more; pairing again");
    return false;
  }
  if (!response.ok) throw new Error(`machine check failed: ${response.status}`);
  const { machineName } = (await response.json()) as MachineCheckResponse;
  log.detail(`talos: the server knows this machine as ${machineName}`);
  return true;
};

// Shows a code for Joe to type into the page, then waits for him to approve
// it. Starts over with a fresh code if this one runs out.
export const pairMachine = async (serverOrigin: string, machineName: string, log: Logger): Promise<string> => {
  const { pairingId, userCode } = await postJson<PairStartResponse>(new URL(SERVER_ROUTES.pairStart, serverOrigin), {
    machineName,
  });
  log.event(`\ntalos: this machine isn't paired yet.`);
  log.event(`talos: open ${serverOrigin}, sign in, and enter this code under "Pair a machine":\n`);
  log.event(`    ${userCode}\n`);

  const pollUrl = new URL(SERVER_ROUTES.pairPoll, serverOrigin);
  const waitForApproval = async (): Promise<string | null> => {
    await Bun.sleep(PAIR_POLL_INTERVAL_MS);
    const pollResult = await postJson<PairPollResponse>(pollUrl, { pairingId });
    if (pollResult.status === "approved") {
      log.event("talos: paired; saving this machine's key");
      return pollResult.machineKey;
    }
    if (pollResult.status === "expired") return null;
    log.detail("talos: still waiting for the code to be entered");
    return waitForApproval();
  };

  const machineKey = await waitForApproval();
  if (machineKey) return machineKey;
  log.event("talos: that code ran out; here's a new one.");
  return pairMachine(serverOrigin, machineName, log);
};
