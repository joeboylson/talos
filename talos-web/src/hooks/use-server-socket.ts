import { useCallback, useEffect, useRef, useState } from "react";
import { RECONNECT_DELAY_MS, SERVER_ROUTES, decode, encode, type PageToServer, type ServerToPage } from "talos-shared";
import type { PreparedImage } from "@/images";
import { EMPTY_PAGE_STATE, addWaitingPrompt, applyServerMessage, droppedPreviewUrls, forgetEntries, forgetReturned, type PageState } from "@/page-state";

// The page's live line to the server: the person's machines as they connect
// and disconnect, each machine's latest ping reply, and each session's
// entries as they happen. Reconnects if it drops.
// A socket that isn't open drops what's sent (or, while connecting, throws),
// so nothing is sent then, and the caller hears it wasn't.
export const sendIfOpen = (socket: Pick<WebSocket, "readyState" | "send"> | null, text: string): boolean => {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(text);
  return true;
};
const NOT_CONNECTED = "Not connected; try again once it's back";

export const useServerSocket = () => {
  const [pageState, setPageState] = useState<PageState>(EMPTY_PAGE_STATE);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  // A waiting message's image previews are freed once it's gone from the page.
  const lastPageState = useRef<PageState>(EMPTY_PAGE_STATE);
  useEffect(() => {
    droppedPreviewUrls(lastPageState.current, pageState).forEach((url) => URL.revokeObjectURL(url));
    lastPageState.current = pageState;
  }, [pageState]);

  useEffect(() => {
    let isStopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const socketScheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.pageSocket}`);
      socketRef.current = socket;
      socket.onopen = () => {
        setPageState(forgetEntries);
        setIsConnected(true);
      };
      socket.onmessage = (event) => {
        const message = decode<ServerToPage>(event.data);
        if (message) setPageState((current) => applyServerMessage(current, message));
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

  const setNotice = useCallback((notice: string | null) => setPageState((current) => ({ ...current, notice })), []);

  // Each session command carries an id of its own, so a refusal comes back to
  // this page only, and names what it refused. False when it wasn't sent.
  const send = useCallback(
    (message: PageToServer, requestId: string = crypto.randomUUID()): boolean => {
      const isSent = sendIfOpen(socketRef.current, encode(message.type === "ping" ? message : { ...message, requestId }));
      setNotice(isSent ? null : NOT_CONNECTED);
      return isSent;
    },
    [setNotice],
  );

  const ping = useCallback((machineId?: string) => send({ type: "ping", machineId }), [send]);

  const startSession = useCallback(
    (machineId: string, folderName: string, sessionName?: string) =>
      send({ type: "start-session", machineId, folderName, sessionName }),
    [send],
  );

  const sendToSession = useCallback(
    (machineId: string, sessionName: string, text: string, images: PreparedImage[]) => {
      const imagePreviewUrls = images.map(({ previewUrl }) => previewUrl);
      const requestId = crypto.randomUUID();
      const sentImages = images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
      const isSent = send({ type: "send-to-session", machineId, sessionName, text, images: sentImages }, requestId);
      if (isSent) setPageState((current) => addWaitingPrompt(current, machineId, sessionName, text, imagePreviewUrls, requestId, sentImages));
      return isSent;
    },
    [send],
  );

  const interruptSession = useCallback(
    (machineId: string, sessionName: string) => send({ type: "interrupt-session", machineId, sessionName }),
    [send],
  );

  const takeReturned = useCallback((key: string) => setPageState((current) => forgetReturned(current, key)), []);

  const stopSession = useCallback(
    (machineId: string, sessionName: string) => send({ type: "stop-session", machineId, sessionName }),
    [send],
  );

  const askForUpdate = useCallback(
    (machineId: string, sessionName: string) => send({ type: "ask-for-output", machineId, sessionName, kind: "status" }),
    [send],
  );

  const answerOutput = useCallback(
    (machineId: string, sessionName: string, outputId: string, choice: number) =>
      send({ type: "answer-output", machineId, sessionName, outputId, choice }),
    [send],
  );

  return {
    ...pageState,
    setNotice,
    isConnected,
    ping,
    startSession,
    sendToSession,
    interruptSession,
    takeReturned,
    stopSession,
    askForUpdate,
    answerOutput,
  };
};

export type ServerSocket = ReturnType<typeof useServerSocket>;
