import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_ENTRIES_KEPT,
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  mergeSessionEntries,
  type MachineSummary,
  type PageToServer,
  type ServerToPage,
  type SessionEntry,
} from "talos-shared";
import type { PreparedImage } from "@/images";
import { removeAnsweredPrompt, sessionKey, type WaitingPrompt } from "@/session-rows";

// The page's live line to the server: the person's machines as they connect
// and disconnect, each machine's latest ping reply, and each session's
// entries as they happen. Reconnects if it drops.
export const useServerSocket = () => {
  const [machines, setMachines] = useState<MachineSummary[] | null>(null);
  const [roundTripMsByMachineId, setRoundTripMsByMachineId] = useState<Record<string, number>>({});
  const [entriesBySession, setEntriesBySession] = useState<Record<string, SessionEntry[]>>({});
  const [waitingPromptsBySession, setWaitingPromptsBySession] = useState<Record<string, WaitingPrompt[]>>({});
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
      const savedPrompts = message.entries.filter((entry) => entry.kind === "prompt");
      setEntriesBySession((current) => ({
        ...current,
        [key]: mergeSessionEntries(current[key] ?? [], message.entries, MAX_ENTRIES_KEPT),
      }));
      setWaitingPromptsBySession((current) => ({
        ...current,
        [key]: savedPrompts.reduce(removeAnsweredPrompt, current[key] ?? []),
      }));
    };

    const connect = () => {
      const socketScheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.pageSocket}`);
      socketRef.current = socket;
      socket.onopen = () => {
        // The server sends every kept entry again on each new connection.
        setEntriesBySession({});
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
    (machineId: string, sessionName: string, text: string, images: PreparedImage[]) => {
      const key = sessionKey(machineId, sessionName);
      const waitingPrompt = { text: text.trim(), imagePreviewUrls: images.map(({ previewUrl }) => previewUrl) };
      setWaitingPromptsBySession((current) => ({ ...current, [key]: [...(current[key] ?? []), waitingPrompt] }));
      const sentImages = images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
      send({ type: "send-to-session", machineId, sessionName, text, images: sentImages });
    },
    [send],
  );

  const stopSession = useCallback(
    (machineId: string, sessionName: string) => send({ type: "stop-session", machineId, sessionName }),
    [send],
  );

  const askForUpdate = useCallback(
    (machineId: string, sessionName: string) => send({ type: "ask-for-update", machineId, sessionName }),
    [send],
  );

  return {
    machines,
    roundTripMsByMachineId,
    entriesBySession,
    waitingPromptsBySession,
    notice,
    setNotice,
    isConnected,
    ping,
    startSession,
    sendToSession,
    stopSession,
    askForUpdate,
  };
};

export type ServerSocket = ReturnType<typeof useServerSocket>;
