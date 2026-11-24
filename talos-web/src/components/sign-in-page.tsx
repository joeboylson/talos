import { CpuIcon, LogInIcon } from "lucide-react";
import { SERVER_ROUTES, SIGN_IN_CLOSED, SIGN_IN_RESULT_PARAM } from "talos-shared";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SIGN_IN_CLOSED_MESSAGE } from "@/describe";
import { keepPairCodeForSignIn } from "@/pairing-link";
import { useEffect } from "react";

// Laid out like shadcn's login blocks: the name above one centered card.
export const SignInPage = () => {
  // A pairing link opened before signing in: its code waits for after.
  useEffect(keepPairCodeForSignIn, []);
  const wasTurnedAway = new URLSearchParams(location.search).get(SIGN_IN_RESULT_PARAM) === SIGN_IN_CLOSED;

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <CpuIcon className="size-4" />
          </div>
          Talos
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4">
            {wasTurnedAway && <p className="text-center text-sm text-destructive">{SIGN_IN_CLOSED_MESSAGE}</p>}
            <Button asChild className="w-full">
              <a href={SERVER_ROUTES.signIn}>
                <LogInIcon />
                GitHub
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
