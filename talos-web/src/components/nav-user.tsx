import { EllipsisVerticalIcon, LogOutIcon } from "lucide-react";
import type { CurrentUserResponse } from "talos-shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { buildInitials } from "@/describe";

type NavUserProps = { currentUser: CurrentUserResponse; onSignOut: () => void };

const UserSummary = ({ currentUser }: { currentUser: CurrentUserResponse }) => (
  <>
    <Avatar className="h-8 w-8 rounded-lg">
      <AvatarFallback className="rounded-lg">{buildInitials(currentUser.displayName)}</AvatarFallback>
    </Avatar>
    <div className="grid flex-1 text-left text-sm leading-tight">
      <span className="truncate font-medium">{currentUser.displayName}</span>
      <span className="truncate text-xs text-muted-foreground">{currentUser.isAdmin ? "Admin" : "Member"}</span>
    </div>
  </>
);

export const NavUser = ({ currentUser, onSignOut }: NavUserProps) => {
  const { isMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <UserSummary currentUser={currentUser} />
              <EllipsisVerticalIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <UserSummary currentUser={currentUser} />
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
