import { useEffect, useState } from "react";
import { LOCAL_STATUS_URL, type LocalStatus } from "talos-shared";
import { LOCAL_STATUS_CHECK_INTERVAL_MS } from "@/constants";

// Asks talos on this same computer about itself. On a computer without talos
// the request fails; that's the normal case, so the status is just null.
const fetchLocalStatus = async (): Promise<LocalStatus | null> => {
  try {
    const response = await fetch(LOCAL_STATUS_URL);
    return response.ok ? ((await response.json()) as LocalStatus) : null;
  } catch {
    return null;
  }
};

export const useLocalStatus = (): LocalStatus | null => {
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);

  useEffect(() => {
    const refresh = () => fetchLocalStatus().then(setLocalStatus);
    refresh();
    const refreshTimer = setInterval(refresh, LOCAL_STATUS_CHECK_INTERVAL_MS);
    return () => clearInterval(refreshTimer);
  }, []);

  return localStatus;
};
