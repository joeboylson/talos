import { hostname } from "node:os";
import { ENV_KEYS, RECONNECT_DELAY_MS, createLogger, httpOriginFromServerUrl, readLogsMode, requireEnv } from "talos-shared";
import { forgetMachineKey, readMachineKey, saveMachineKey } from "./credentials";
import { startLocalStatusServer } from "./local-status-server";
import { isMachineKeyAccepted, pairMachine } from "./pairing";
import { connectToServer } from "./server-connection";

const serverUrl = requireEnv(ENV_KEYS.serverUrl);
const serverOrigin = httpOriginFromServerUrl(serverUrl);
const machineName = process.env[ENV_KEYS.machineName] || hostname();
const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));

// The one value talos changes as it runs. Everything else is passed in.
let isConnected = false;

// A saved key the server no longer knows (the machine was removed from the
// page) is thrown away, and the machine pairs again.
const getAcceptedMachineKey = async (): Promise<string> => {
  const savedMachineKey = await readMachineKey(serverUrl);
  if (savedMachineKey && (await isMachineKeyAccepted(serverOrigin, savedMachineKey, log))) return savedMachineKey;
  if (savedMachineKey) await forgetMachineKey();

  const machineKey = await pairMachine(serverOrigin, machineName, log);
  await saveMachineKey({ serverUrl, machineKey });
  return machineKey;
};

// Each connection, and each retry after it drops, starts by checking the key.
const connect = async (): Promise<void> => {
  const machineKey = await getAcceptedMachineKey();
  connectToServer({
    serverUrl,
    machineKey,
    log,
    onConnectionChange: (isNowConnected) => {
      isConnected = isNowConnected;
      if (!isNowConnected) setTimeout(connectWithRetry, RECONNECT_DELAY_MS);
    },
  });
};

// While the server is down, keep trying instead of crashing.
const connectWithRetry = (): void => {
  connect().catch((error: unknown) => {
    log.event(`talos: can't reach ${serverOrigin} (${error}), retrying in ${RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(connectWithRetry, RECONNECT_DELAY_MS);
  });
};

startLocalStatusServer({
  allowedOrigin: serverOrigin,
  readLocalStatus: () => ({ machineName, isConnected }),
  log,
});
log.event(`talos: starting as ${machineName}, server ${serverOrigin}`);

connectWithRetry();
