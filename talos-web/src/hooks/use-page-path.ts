import { useCallback, useEffect, useState } from "react";
import { PAGE_KINDS, buildPagePath, type PageKind } from "talos-shared";

const DEFAULT_PAGE_KIND: PageKind = "machines";

// Where an address points: /folders → folders; /sessions/atlas/fix-login →
// that session (talos:machines:atlas:sessions:fix-login). Anything unknown
// shows machines.
export type PageLocation = { pageKind: PageKind; machineName: string | null; sessionName: string | null };

export const readPageLocation = (pathname: string): PageLocation => {
  const [firstPart, machineName, sessionName] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const pageKind = PAGE_KINDS.find((kind) => kind === firstPart) ?? DEFAULT_PAGE_KIND;
  const isSession = pageKind === "sessions" && machineName !== undefined && sessionName !== undefined;
  return { pageKind, machineName: isSession ? machineName : null, sessionName: isSession ? sessionName : null };
};

export const buildLocationPath = ({ pageKind, machineName, sessionName }: PageLocation): string =>
  buildPagePath(machineName && sessionName ? [pageKind, machineName, sessionName] : [pageKind]);

// Keeps the shown page and the address bar in step, including back and forward.
export const usePagePath = () => {
  const [pageLocation, setPageLocation] = useState<PageLocation>(() => readPageLocation(location.pathname));

  useEffect(() => {
    const followAddressBar = () => setPageLocation(readPageLocation(location.pathname));
    addEventListener("popstate", followAddressBar);
    return () => removeEventListener("popstate", followAddressBar);
  }, []);

  const openPage = useCallback((nextLocation: PageLocation) => {
    history.pushState(null, "", buildLocationPath(nextLocation));
    setPageLocation(nextLocation);
  }, []);

  return { pageLocation, openPage };
};
