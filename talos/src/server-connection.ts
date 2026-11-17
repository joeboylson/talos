import {
  BEARER_PREFIX,
  MACHINE_NAME_QUERY_PARAM,
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  type MachineToServer,
  type ServerToMachine,
} from "talos-shared";

type ServerConnectionOptions = {
  serverUrl: string;
  machineKey: string;
  machineName: string;
  onConnectionChange: (isConnected: boolean) => void;
};

// talos always calls the server, never the other way round, so this machine
// doesn't have to accept connections from anywhere. Reconnects forever.
export const connectToServer = (options: ServerConnectionOptions): void => {
  const { serverUrl, machineKey, machineName, onConnectionChange } = options;
  const machineUrl = new URL(SERVER_ROUTES.machine, serverUrl);
  machineUrl.searchParams.set(MACHINE_NAME_QUERY_PARAM, machineName);

  const socket = new WebSocket(machineUrl, {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });

  socket.onopen = () => {
    onConnectionChange(true);
    console.log(`talos: connected to ${serverUrl} as ${machineName}`);
  };

  socket.onmessage = (event) => {
    const message = decode<ServerToMachine>(event.data);
    if (message?.type !== "ping") return;
    console.log("talos: ping");
    socket.send(encode<MachineToServer>({ type: "pong", id: message.id }));
  };

  socket.onclose = (event) => {
    onConnectionChange(false);
    console.log(`talos: disconnected (${event.code}), retrying in ${RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(() => connectToServer(options), RECONNECT_DELAY_MS);
  };
};
