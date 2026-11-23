import {
  BEARER_PREFIX,
  KEEP_ALIVE_GONE_MS,
  SERVER_ROUTES,
  WS_CLOSE_CODES,
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
  // How long a silent server is waited for (tests shorten it).
  silentAfterMs?: number;
};

const CLOSE_WAIT_MS = 5000;

// talos always calls the server, never the other way round, so this machine
// doesn't have to accept connections from anywhere.
export const connectToServer = (options: ServerConnectionOptions): void => {
  const { serverUrl, machineKey, onConnectionChange, onOpen, onServerMessage, log, silentAfterMs = KEEP_ALIVE_GONE_MS } = options;
  const socket = new WebSocket(new URL(SERVER_ROUTES.machineSocket, serverUrl), {
    headers: { Authorization: `${BEARER_PREFIX}${machineKey}` },
  });

  // The server writes at least every 30 s; hearing nothing for longer means it
  // or the network is gone (a frozen server, a laptop waking on another
  // network), so the connection is closed and the usual reconnect takes over.
  // Timed from the start too: a connection can hang before it opens, and Bun
  // gives up on none.
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const heardFromServer = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      log.event("talos: heard nothing from the server for too long; reconnecting");
      socket.close();
      // A close on a dead network may never finish, so it's taken as done.
      setTimeout(() => closed(WS_CLOSE_CODES.silent, "heard nothing"), CLOSE_WAIT_MS);
    }, silentAfterMs);
  };
  heardFromServer();
  let isClosed = false;
  const closed = (code: number, reason: string) => {
    if (isClosed) return;
    isClosed = true;
    clearTimeout(silenceTimer);
    log.event(`talos: disconnected (${code}${reason ? `: ${reason}` : ""})`);
    onConnectionChange(false, code);
  };

  socket.onopen = () => {
    heardFromServer();
    onConnectionChange(true);
    log.event(`talos: connected to ${serverUrl}`);
    onOpen((message) => socket.send(encode<MachineToServer>(message)));
  };

  socket.onmessage = (event) => {
    heardFromServer();
    const message = readServerToMachine(parseJsonOrNull(String(event.data)));
    if (!message) return log.warn("talos: the server sent a message talos can't read; ignoring it");
    if (message.type !== "ping") return onServerMessage(message);
    log.detail("talos: ping from the server, sending pong");
    socket.send(encode<MachineToServer>({ type: "pong", id: message.id }));
  };

  socket.onclose = (event) => closed(event.code, event.reason);
};
