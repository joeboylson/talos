import {
  BEARER_PREFIX,
  SERVER_ROUTES,
  encode,
  parseJsonOrNull,
  readServerToMachine,
  type Logger,
  type MachineToServer,
  type ServerToMachine,
} from "talos-shared";

export type SendToServer = (message: MachineToServer) => void;

type ServerConnectionOptions = {
  serverUrl: string;
  machineKey: string;
  // closeCode says why a connection closed (see WS_CLOSE_CODES).
  onConnectionChange: (isConnected: boolean, closeCode?: number) => void;
  onOpen: (sendToServer: SendToServer) => void;
  // Everything but pings, which are answered here.
  onServerMessage: (message: Exclude<ServerToMachine, { type: "ping" }>) => void;
  log: Logger;
};

// talos always calls the server, never the other way round, so this machine
// doesn't have to accept connections from anywhere.
export const connectToServer = (options: ServerConnectionOptions): void => {
  const { serverUrl, machineKey, onConnectionChange, onOpen, onServerMessage, log } = options;
  const socket = new WebSocket(new URL(SERVER_ROUTES.machineSocket, serverUrl), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });

  socket.onopen = () => {
    onConnectionChange(true);
    log.event(`talos: connected to ${serverUrl}`);
    onOpen((message) => socket.send(encode<MachineToServer>(message)));
  };

  socket.onmessage = (event) => {
    const message = readServerToMachine(parseJsonOrNull(String(event.data)));
    if (!message) return log.warn("talos: the server sent a message talos can't read; ignoring it");
    if (message.type !== "ping") return onServerMessage(message);
    log.detail("talos: ping from the server, sending pong");
    socket.send(encode<MachineToServer>({ type: "pong", id: message.id }));
  };

  socket.onclose = (event) => {
    log.event(`talos: disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
    onConnectionChange(false, event.code);
  };
};
