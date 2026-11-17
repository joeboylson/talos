import { useCallback, useEffect, useRef, useState } from "react";
import {
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  type MachineSummary,
  type PageToServer,
  type ServerToPage,
} from "talos-shared";

// The page's live line to the server: the person's machines as they connect
// and disconnect, and each machine's latest ping reply. Reconnects if it drops.
export const useServerSocket = () => {
  const [machines, setMachines] = useState<MachineSummary[] | null>(null);
  const [roundTripMsByMachineId, setRoundTripMsByMachineId] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let isStopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleMessage = (message: ServerToPage) => {
      if (message.type === "machines") return setMachines(message.machines);
      if (message.type === "error") return setNotice(message.message);
      setRoundTripMsByMachineId((current) => ({ ...current, [message.machineId]: message.roundTripMs }));
    };

    const connect = () => {
      const socketScheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.pageSocket}`);
      socketRef.current = socket;
      socket.onopen = () => setIsConnected(true);
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

  const ping = useCallback((machineId?: string) => {
    setNotice(null);
    socketRef.current?.send(encode<PageToServer>({ type: "ping", machineId }));
  }, []);

  return { machines, roundTripMsByMachineId, notice, setNotice, isConnected, ping };
};
