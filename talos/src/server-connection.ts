import {
  BEARER_PREFIX,
  SERVER_ROUTES,
  decode,
  encode,
  type Logger,
  type MachineToServer,
  type ServerToMachine,
} from "talos-shared";

type ServerConnectionOptions = {
  serverUrl: string;
  machineKey: string;
  onConnectionChange: (isConnected: boolean) => void;
  log: Logger;
};

// talos always calls the server, never the other way round, so this machine
// doesn't have to accept connections from anywhere.
export const connectToServer = ({ serverUrl, machineKey, onConnectionChange, log }: ServerConnectionOptions): void => {
  const socket = new WebSocket(new URL(SERVER_ROUTES.machineSocket, serverUrl), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });

  socket.onopen = () => {
    onConnectionChange(true);
    log.event(`talos: connected to ${serverUrl}`);
  };

  socket.onmessage = (event) => {
    const message = decode<ServerToMachine>(event.data);
    if (message?.type !== "ping") return;
    log.detail("talos: ping from the server, sending pong");
    socket.send(encode<MachineToServer>({ type: "pong", id: message.id }));
  };

  socket.onclose = (event) => {
    log.event(`talos: disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
    onConnectionChange(false);
  };
};
