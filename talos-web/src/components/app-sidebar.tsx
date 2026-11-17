import { CpuIcon, FolderIcon, MessagesSquareIcon, ServerIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import type { CurrentUserResponse } from "talos-shared";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { VIEWS, type View } from "@/constants";

type AppSidebarProps = ComponentProps<typeof Sidebar> & {
  currentUser: CurrentUserResponse;
  activeView: View;
  onViewChange: (view: View) => void;
  onSignOut: () => void;
};

type NavItem = { view: View; icon: LucideIcon };

const MACHINES_ITEM: NavItem = { view: "machines", icon: ServerIcon };
const FOLDERS_ITEM: NavItem = { view: "folders", icon: FolderIcon };
const SESSIONS_ITEM: NavItem = { view: "sessions", icon: MessagesSquareIcon };
const SETTINGS_ITEM: NavItem = { view: "settings", icon: SettingsIcon };

// Settings only appear for the admin.
const buildNavItems = (isAdmin: boolean): NavItem[] =>
  isAdmin ? [MACHINES_ITEM, FOLDERS_ITEM, SESSIONS_ITEM, SETTINGS_ITEM] : [MACHINES_ITEM, FOLDERS_ITEM, SESSIONS_ITEM];

export const AppSidebar = ({ currentUser, activeView, onViewChange, onSignOut, ...sidebarProps }: AppSidebarProps) => (
  <Sidebar collapsible="offcanvas" {...sidebarProps}>
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!" onClick={() => onViewChange("machines")}>
            <CpuIcon className="size-5!" />
            <span className="text-base font-semibold">Talos</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {buildNavItems(currentUser.isAdmin).map(({ view, icon: Icon }) => (
              <SidebarMenuItem key={view}>
                <SidebarMenuButton tooltip={VIEWS[view].title} isActive={activeView === view} onClick={() => onViewChange(view)}>
                  <Icon />
                  <span>{VIEWS[view].title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <NavUser currentUser={currentUser} onSignOut={onSignOut} />
    </SidebarFooter>
  </Sidebar>
);
