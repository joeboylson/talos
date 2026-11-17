import {
  BEARER_PREFIX,
  SERVER_ROUTES,
  decode,
  encode,
  type MachineToServer,
  type ServerToMachine,
} from "talos-shared";

type ServerConnectionOptions = {
  serverUrl: string;
  machineKey: string;
  onConnectionChange: (isConnected: boolean) => void;
};

// talos always calls the server, never the other way round, so this machine
// doesn't have to accept connections from anywhere.
export const connectToServer = ({ serverUrl, machineKey, onConnectionChange }: ServerConnectionOptions): void => {
  const socket = new WebSocket(new URL(SERVER_ROUTES.machineSocket, serverUrl), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });

  socket.onopen = () => {
    onConnectionChange(true);
    console.log(`talos: connected to ${serverUrl}`);
  };

  socket.onmessage = (event) => {
    const message = decode<ServerToMachine>(event.data);
    if (message?.type !== "ping") return;
    console.log("talos: ping");
    socket.send(encode<MachineToServer>({ type: "pong", id: message.id }));
  };

  socket.onclose = (event) => {
    console.log(`talos: disconnected (${event.code} ${event.reason})`);
    onConnectionChange(false);
  };
};
