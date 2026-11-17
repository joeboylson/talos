import type { LocalStatus, ServerToPage } from "talos-shared";

export const describeMachineList = (machineNames: string[]): string =>
  machineNames.length > 0 ? `Connected: ${machineNames.join(", ")}` : "No machines connected";

export const describeLocalStatus = ({ machineName, isConnected }: LocalStatus): string => {
  const connectionText = isConnected ? "connected to the server" : "not connected to the server";
  return `${machineName}: talos is running, ${connectionText}`;
};

export const formatLogLine = (text: string, loggedAt: Date): string =>
  `${loggedAt.toLocaleTimeString()}  ${text}`;

// The log line a server message adds, or null if it doesn't add one.
export const describeServerMessage = (message: ServerToPage): string | null => {
  if (message.type === "pong") return `pong from ${message.machineName} (${message.roundTripMs} ms)`;
  if (message.type === "error") return message.message;
  return null;
};
