import { Fragment } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Each step of where you are, matching the address: Machines › work-mac.
// Every step but the last goes back to that page.
export type Crumb = { label: string; onOpen?: () => void };

type SiteHeaderProps = { crumbs: Crumb[]; isLive: boolean };

export const SiteHeader = ({ crumbs, isLive }: SiteHeaderProps) => (
  <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
    <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList className="text-base">
          {crumbs.map((crumb, crumbIndex) => (
            <Fragment key={crumb.label}>
              {crumbIndex > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {crumb.onOpen ? (
                  <BreadcrumbLink asChild>
                    <button type="button" onClick={crumb.onOpen}>
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="font-medium">{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
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
