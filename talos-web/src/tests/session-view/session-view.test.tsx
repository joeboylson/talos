import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../../components/session-view";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { SessionRow } from "../../session-rows";

const sessionRow = { machineId: "m1", machineName: "atlas", sessionName: "web", folderName: "proj", state: "idle", isPromptShowing: false } as SessionRow;

test("what the person couldn't do in a session is shown in it", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={sessionRow} entries={[]} waitingPrompts={[]} onSend={() => true} onAnswer={() => {}} onInterrupt={() => {}} onReturnedTaken={() => {}} notice="atlas: That question closed" />
    </TooltipProvider>,
  );
  expect(html).toContain("atlas: That question closed");
});

const decision = { id: "d1", question: "Which one?", choices: ["A", "B"], atMs: 0 };
const viewOf = (row: Partial<SessionRow>, waitingPrompts: { text: string; imagePreviewUrls: string[] }[] = []) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SessionView
        sessionRow={{ ...sessionRow, state: "needs-you", decision, ...row }}
        entries={[]}
        waitingPrompts={waitingPrompts}
        onSend={() => true}
        onAnswer={() => {}}
        onInterrupt={() => {}}
        onReturnedTaken={() => {}}
        notice={null}
      />
    </TooltipProvider>,
  );

test("a question's buttons show once the turn is over; during a permission prompt the page says to answer in the terminal", () => {
  expect(viewOf({ isPromptShowing: false })).toContain("Which one?");
  const atPrompt = viewOf({ isPromptShowing: true });
  expect(atPrompt).toContain("Answer in the terminal");
  expect(atPrompt).not.toContain("Which one?");
});

test("a running turn can be interrupted, a permission prompt's included; a ready session can't", () => {
  expect(viewOf({ state: "working" })).toContain('aria-label="Interrupt"');
  expect(viewOf({ state: "needs-you", isPromptShowing: true })).toContain('aria-label="Interrupt"');
  expect(viewOf({ state: "idle" })).not.toContain('aria-label="Interrupt"');
});

test("messages waiting from other pages show, and this page's own show once", () => {
  const html = viewOf({ state: "working", waitingMessages: ["from my phone", "from here"] }, [{ text: "from here", imagePreviewUrls: [] }]);
  expect(html).toContain("from my phone");
  expect(html.split("from here").length - 1).toBe(1);
});
