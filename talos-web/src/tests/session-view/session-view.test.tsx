import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../../components/session-view";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { SessionRow } from "../../session-rows";

const sessionRow = { machineId: "m1", machineName: "atlas", sessionName: "web", folderName: "proj", state: "idle", isMachineConnected: true, isPromptShowing: false } as SessionRow;

test("what the person couldn't do in a session is shown in it", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={sessionRow} isLoading={false} draftKey="atlas/web" entries={[]} waitingPrompts={[]} onSend={() => true} onAnswer={() => {}} onInterrupt={() => {}} onAnswerPermission={() => {}} onReturnedTaken={() => {}} notice="atlas: That question closed" />
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
        isLoading={false}
        draftKey="atlas/web"
        entries={[]}
        waitingPrompts={waitingPrompts}
        onSend={() => true}
        onAnswer={() => {}}
        onInterrupt={() => {}}
        onAnswerPermission={() => {}}
        onReturnedTaken={() => {}}
        notice={null}
      />
    </TooltipProvider>,
  );

test("a question's buttons show once the turn is over; mid-turn with no permission listed, the page says it's not responding", () => {
  expect(viewOf({ isPromptShowing: false })).toContain("Which one?");
  const atPrompt = viewOf({ isPromptShowing: true });
  expect(atPrompt).toContain("Not responding");
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

test("a permission prompt shows its tool and what it would do, with Allow and Deny", () => {
  const html = viewOf({ state: "needs-you", isPromptShowing: true, permissionAsks: [{ id: "t1", tool: "Bash", summary: "rm -rf build" }] });
  expect(html).toContain("Bash");
  expect(html).toContain("rm -rf build");
  expect(html).toContain('aria-label="Allow"');
  expect(html).toContain('aria-label="Deny"');
  expect(html).not.toContain("Answer in the terminal");
});

test("an offline machine's session keeps its conversation, says Offline, and can't be answered or sent to", () => {
  const html = viewOf({ isMachineConnected: false });
  expect(html).toContain("Offline");
  expect(html).not.toContain("Which one?");
  expect(html).toMatch(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/);
});

test("while the machine list is still coming, a session isn't called missing", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SessionView sessionRow={null} isLoading draftKey="atlas/web" entries={[]} waitingPrompts={[]} onSend={() => true} onAnswer={() => {}} onInterrupt={() => {}} onAnswerPermission={() => {}} onReturnedTaken={() => {}} notice={null} />
    </TooltipProvider>,
  );
  expect(html).not.toContain("No such session");
});
