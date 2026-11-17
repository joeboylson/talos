import { useEffect, useState } from "react";
import type { CurrentUserResponse } from "talos-shared";
import { fetchCurrentUser } from "@/api";
import { Dashboard } from "@/components/dashboard";
import { SignInPage } from "@/components/sign-in-page";

// undefined while loading, null when nobody is signed in.
export const App = () => {
  const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null | undefined>(undefined);

  useEffect(() => {
    fetchCurrentUser().then(setCurrentUser);
  }, []);

  if (currentUser === undefined) return null;
  if (currentUser === null) return <SignInPage />;
  return <Dashboard currentUser={currentUser} />;
};
