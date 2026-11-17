import { useCallback, useEffect, useState } from "react";
import { PAGE_KINDS, buildPagePath, type PageKind } from "talos-shared";

const DEFAULT_PAGE_KIND: PageKind = "machines";

// The page kind an address names: /settings → "settings". Anything unknown
// shows machines.
export const readPageKind = (pathname: string): PageKind => {
  const [firstPart] = pathname.split("/").filter(Boolean);
  return PAGE_KINDS.find((pageKind) => pageKind === firstPart) ?? DEFAULT_PAGE_KIND;
};

// Keeps the shown view and the address bar in step, including back and forward.
export const usePagePath = () => {
  const [pageKind, setPageKind] = useState<PageKind>(() => readPageKind(location.pathname));

  useEffect(() => {
    const followAddressBar = () => setPageKind(readPageKind(location.pathname));
    addEventListener("popstate", followAddressBar);
    return () => removeEventListener("popstate", followAddressBar);
  }, []);

  const openPage = useCallback((nextPageKind: PageKind) => {
    history.pushState(null, "", buildPagePath([nextPageKind]));
    setPageKind(nextPageKind);
  }, []);

  return { pageKind, openPage };
};
