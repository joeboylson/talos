import { hostname } from "node:os";
import { ENV_KEYS, requireEnv } from "talos-shared";
import { pageOriginFromServerUrl } from "./cors";
import { startLocalStatusServer } from "./local-status-server";
import { connectToServer } from "./server-connection";

const serverUrl = requireEnv(ENV_KEYS.serverUrl);
const machineKey = requireEnv(ENV_KEYS.machineKey);
const machineName = process.env[ENV_KEYS.machineName] || hostname();

// The one value talos changes as it runs. Everything else is passed in.
let isConnected = false;

startLocalStatusServer({
  allowedOrigin: pageOriginFromServerUrl(serverUrl),
  readLocalStatus: () => ({ machineName, isConnected }),
});

connectToServer({
  serverUrl,
  machineKey,
  machineName,
  onConnectionChange: (isNowConnected) => {
    isConnected = isNowConnected;
  },
});
