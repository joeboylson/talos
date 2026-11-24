import { useCallback, type CSSProperties } from "react";
import type { CurrentUserResponse, MachineSummary } from "talos-shared";
import { removeMachine, signOut } from "@/api";
import { AppSidebar } from "@/components/app-sidebar";
import { FoldersTable } from "@/components/folders-table";
import { MachinesTable } from "@/components/machines-table";
import { SessionView } from "@/components/session-view";
import { SessionsTable } from "@/components/sessions-table";
import { SettingsView } from "@/components/settings-view";
import { SiteHeader, type Crumb } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { VIEWS, type View } from "@/constants";
import { useLocalStatus } from "@/hooks/use-local-status";
import { usePagePath } from "@/hooks/use-page-path";
import { useServerSocket } from "@/hooks/use-server-socket";
import { findSessionRow, sessionKey, type SessionRow } from "@/session-rows";

// Sizes from shadcn's dashboard-01 block.
const LAYOUT_SIZES = {
  "--sidebar-width": "calc(var(--spacing) * 72)",
  "--header-height": "calc(var(--spacing) * 12)",
} as CSSProperties;

export const Dashboard = ({ currentUser }: { currentUser: CurrentUserResponse }) => {
  const { pageLocation, openPage } = usePagePath();
  // Settings belong to the admin; anyone else at /settings sees their machines.
  const isHiddenSettings = pageLocation.pageKind === "settings" && !currentUser.isAdmin;
  const activeView = isHiddenSettings ? "machines" : pageLocation.pageKind;
  const serverSocket = useServerSocket();
  const { machines, notice, setNotice, isConnected } = serverSocket;
  const localStatus = useLocalStatus();
  const machineList = machines ?? [];

  const openView = (pageKind: View) => openPage({ pageKind, machineName: null, sessionName: null });
  const openSession = ({ machineName, sessionName }: SessionRow) =>
    openPage({ pageKind: "sessions", machineName, sessionName });

  const { machineName: openMachineName, sessionName: openSessionName } = pageLocation;
  const isSessionOpen = activeView === "sessions" && openMachineName !== null && openSessionName !== null;
  const openSessionRow = isSessionOpen ? findSessionRow(machineList, openMachineName, openSessionName) : null;
  // Its sessions aren't known yet (the list hasn't come, or the server just
  // started and the machine hasn't reported), so it isn't "no such session" yet.
  const openMachine = machineList.find(({ machineName }) => machineName === openMachineName);
  const isOpenSessionLoading = machines === null || openMachine?.sessions === null;
  const openSessionKey = openSessionRow ? sessionKey(openSessionRow.machineId, openSessionRow.sessionName) : "";
  const { takeReturned } = serverSocket;
  const takeOpenReturned = useCallback(() => takeReturned(openSessionKey), [takeReturned, openSessionKey]);
  const crumbs: Crumb[] = isSessionOpen
    ? [
        { label: VIEWS.sessions.title, onOpen: () => openView("sessions") },
        { label: `${openMachineName} / ${openSessionName}` },
      ]
    : [{ label: VIEWS[activeView].title }];

  // No "are you sure?": a removed machine just pairs again to come back.
  const handleRemove = (machine: MachineSummary) =>
    removeMachine(machine.machineId).catch(() => setNotice(`Couldn't remove ${machine.machineName}.`));

  const handleSignOut = async () => {
    await signOut();
    location.reload();
  };

  return (
    <SidebarProvider style={LAYOUT_SIZES}>
      <AppSidebar
        variant="inset"
        currentUser={currentUser}
        activeView={activeView}
        onViewChange={openView}
        onSignOut={handleSignOut}
      />
      <SidebarInset>
        <SiteHeader crumbs={crumbs} isLive={isConnected} />
        <div className="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          {activeView === "machines" && (
            <MachinesTable
              machines={machineList}
              roundTripMsByMachineId={serverSocket.roundTripMsByMachineId}
              localStatus={localStatus}
              notice={notice}
              canPing={isConnected}
              onPing={serverSocket.ping}
              onRemove={handleRemove}
            />
          )}
          {activeView === "folders" && <FoldersTable machines={machineList} />}
          {activeView === "sessions" && !isSessionOpen && (
            <SessionsTable
              machines={machines}
              notice={notice}
              onStart={serverSocket.startSession}
              onOpen={openSession}
              onStop={({ machineId, sessionName }) => serverSocket.stopSession(machineId, sessionName)}
              onAskUpdate={({ machineId, sessionName }) => serverSocket.askForUpdate(machineId, sessionName)}
            />
          )}
          {isSessionOpen && (
            <SessionView
              sessionRow={openSessionRow}
              isLoading={isOpenSessionLoading}
              draftKey={`${openMachineName}/${openSessionName}`}
              entries={serverSocket.entriesBySession[openSessionKey] ?? []}
              waitingPrompts={serverSocket.waitingPromptsBySession[openSessionKey] ?? []}
              notice={notice}
              onSend={(text, images) =>
                openSessionRow !== null && serverSocket.sendToSession(openSessionRow.machineId, openSessionRow.sessionName, text, images)
              }
              onAnswer={(outputId, choice) =>
                openSessionRow && serverSocket.answerOutput(openSessionRow.machineId, openSessionRow.sessionName, outputId, choice)
              }
              onInterrupt={() => openSessionRow && serverSocket.interruptSession(openSessionRow.machineId, openSessionRow.sessionName)}
              onAnswerPermission={(toolUseId, isAllowed) =>
                openSessionRow && serverSocket.answerPermission(openSessionRow.machineId, openSessionRow.sessionName, toolUseId, isAllowed)
              }
              returned={serverSocket.returnedBySession[openSessionKey]}
              onReturnedTaken={takeOpenReturned}
            />
          )}
          {activeView === "settings" && currentUser.isAdmin && <SettingsView />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};
