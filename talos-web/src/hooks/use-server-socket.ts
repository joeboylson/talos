import { useCallback, useEffect, useRef, useState } from "react";
import {
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  type Exchange,
  type MachineSummary,
  type PageToServer,
  type ServerToPage,
} from "talos-shared";
import { removeAnsweredPrompt, sessionKey } from "@/session-rows";

// The page's live line to the server: the person's machines as they connect
// and disconnect, each machine's latest ping reply, and each session's
// exchanges. Reconnects if it drops.
export const useServerSocket = () => {
  const [machines, setMachines] = useState<MachineSummary[] | null>(null);
  const [roundTripMsByMachineId, setRoundTripMsByMachineId] = useState<Record<string, number>>({});
  const [exchangesBySession, setExchangesBySession] = useState<Record<string, Exchange[]>>({});
  const [waitingPromptsBySession, setWaitingPromptsBySession] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let isStopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleMessage = (message: ServerToPage) => {
      if (message.type === "machines") return setMachines(message.machines);
      if (message.type === "error") return setNotice(message.message);
      if (message.type === "pong") {
        return setRoundTripMsByMachineId((current) => ({ ...current, [message.machineId]: message.roundTripMs }));
      }
      const key = sessionKey(message.machineId, message.sessionName);
      setExchangesBySession((current) => ({ ...current, [key]: [...(current[key] ?? []), message.exchange] }));
      setWaitingPromptsBySession((current) => ({
        ...current,
        [key]: removeAnsweredPrompt(current[key] ?? [], message.exchange.prompt),
      }));
    };

    const connect = () => {
      const socketScheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.pageSocket}`);
      socketRef.current = socket;
      socket.onopen = () => {
        // The server sends every kept exchange again on each new connection.
        setExchangesBySession({});
        setIsConnected(true);
      };
      socket.onmessage = (event) => {
        const message = decode<ServerToPage>(event.data);
        if (message) handleMessage(message);
      };
      socket.onclose = () => {
        setIsConnected(false);
        if (!isStopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();
    return () => {
      isStopped = true;
      clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: PageToServer) => {
    setNotice(null);
    socketRef.current?.send(encode(message));
  }, []);

  const ping = useCallback((machineId?: string) => send({ type: "ping", machineId }), [send]);

  const startSession = useCallback(
    (machineId: string, folderName: string, sessionName?: string) =>
      send({ type: "start-session", machineId, folderName, sessionName }),
    [send],
  );

  const sendToSession = useCallback(
    (machineId: string, sessionName: string, text: string) => {
      const key = sessionKey(machineId, sessionName);
      setWaitingPromptsBySession((current) => ({ ...current, [key]: [...(current[key] ?? []), text.trim()] }));
      send({ type: "send-to-session", machineId, sessionName, text });
    },
    [send],
  );

  const stopSession = useCallback(
    (machineId: string, sessionName: string) => send({ type: "stop-session", machineId, sessionName }),
    [send],
  );

  return {
    machines,
    roundTripMsByMachineId,
    exchangesBySession,
    waitingPromptsBySession,
    notice,
    setNotice,
    isConnected,
    ping,
    startSession,
    sendToSession,
    stopSession,
  };
};

export type ServerSocket = ReturnType<typeof useServerSocket>;
