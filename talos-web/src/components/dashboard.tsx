import { useState, type CSSProperties } from "react";
import type { CurrentUserResponse, MachineSummary } from "talos-shared";
import { removeMachine, signOut } from "@/api";
import { AppSidebar } from "@/components/app-sidebar";
import { MachinesTable } from "@/components/machines-table";
import { SettingsView } from "@/components/settings-view";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { VIEWS, type View } from "@/constants";
import { useLocalStatus } from "@/hooks/use-local-status";
import { useServerSocket } from "@/hooks/use-server-socket";

// Sizes from shadcn's dashboard-01 block.
const LAYOUT_SIZES = {
  "--sidebar-width": "calc(var(--spacing) * 72)",
  "--header-height": "calc(var(--spacing) * 12)",
} as CSSProperties;

export const Dashboard = ({ currentUser }: { currentUser: CurrentUserResponse }) => {
  const [activeView, setActiveView] = useState<View>("machines");
  const { machines, roundTripMsByMachineId, notice, setNotice, isConnected, ping } = useServerSocket();
  const localStatus = useLocalStatus();

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
        onViewChange={setActiveView}
        onSignOut={handleSignOut}
      />
      <SidebarInset>
        <SiteHeader title={VIEWS[activeView].title} isLive={isConnected} />
        <div className="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          {activeView === "machines" && (
            <MachinesTable
              machines={machines ?? []}
              roundTripMsByMachineId={roundTripMsByMachineId}
              localStatus={localStatus}
              notice={notice}
              canPing={isConnected}
              onPing={ping}
              onRemove={handleRemove}
            />
          )}
          {activeView === "settings" && currentUser.isAdmin && <SettingsView />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};
