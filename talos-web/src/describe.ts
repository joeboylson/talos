import type { LocalStatus, MachineSummary, ServerToPage } from "talos-shared";

export const describeMachine = ({ machineName, isConnected }: MachineSummary): string =>
  `${machineName}: ${isConnected ? "connected" : "offline"}`;

export const describeMachineCount = (machines: MachineSummary[]): string => {
  if (machines.length === 0) return "No machines paired yet";
  const connectedCount = machines.filter((machine) => machine.isConnected).length;
  return `${connectedCount} of ${machines.length} connected`;
};

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
