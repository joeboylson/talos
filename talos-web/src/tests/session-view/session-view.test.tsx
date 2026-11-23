import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../../components/session-view";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { SessionRow } from "../../session-rows";

const sessionRow = { machineId: "m1", machineName: "atlas", sessionName: "web", folderName: "proj", state: "idle", isPromptShowing: false } as SessionRow;

test("what the person couldn't do in a session is shown in it", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={sessionRow} entries={[]} waitingPrompts={[]} onSend={() => true} onAnswer={() => {}} notice="atlas: That question closed" />
    </TooltipProvider>,
  );
  expect(html).toContain("atlas: That question closed");
});

const decision = { id: "d1", question: "Which one?", choices: ["A", "B"], atMs: 0 };
const viewOf = (row: Partial<SessionRow>) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={{ ...sessionRow, state: "needs-you", decision, ...row }} entries={[]} waitingPrompts={[]} onSend={() => true} onAnswer={() => {}} notice={null} />
    </TooltipProvider>,
  );

test("a question's buttons show once the turn is over; during a permission prompt the page says to answer in the terminal", () => {
  expect(viewOf({ isPromptShowing: false })).toContain("Which one?");
  const atPrompt = viewOf({ isPromptShowing: true });
  expect(atPrompt).toContain("Answer in the terminal");
  expect(atPrompt).not.toContain("Which one?");
});
