import { ModeToggle } from "@/components/mode-toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

type SiteHeaderProps = { title: string; isLive: boolean };

export const SiteHeader = ({ title, isLive }: SiteHeaderProps) => (
  <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
    <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
      <h1 className="text-base font-medium">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="status"
              aria-label={isLive ? "Live" : "Reconnecting"}
              className={isLive ? "size-2 rounded-full bg-green-500" : "size-2 animate-pulse rounded-full bg-muted-foreground"}
            />
          </TooltipTrigger>
          <TooltipContent>{isLive ? "Live" : "Reconnecting"}</TooltipContent>
        </Tooltip>
        <ModeToggle />
      </div>
    </div>
  </header>
);
