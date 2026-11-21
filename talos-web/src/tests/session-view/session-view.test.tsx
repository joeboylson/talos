import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../../components/session-view";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { SessionRow } from "../../session-rows";

const sessionRow = { machineId: "m1", machineName: "atlas", sessionName: "web", folderName: "proj", state: "idle" } as SessionRow;

test("what the person couldn't do in a session is shown in it", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={sessionRow} entries={[]} waitingPrompts={[]} onSend={() => {}} onAnswer={() => {}} notice="atlas: That question closed" />
    </TooltipProvider>,
  );
  expect(html).toContain("atlas: That question closed");
});
