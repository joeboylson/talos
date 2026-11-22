// recipes: a plain chat with a Claude Code session. No kinds at all: the module
// is also just a way to run and talk to a session, and watch it work.
import { CHAT_START, chatFooter, chatMark, chatStep, drawChatEntry, type ChatState } from "../kit/chat";
import { bold } from "../kit/screen";
import type { ExampleView } from "../kit/view";

export type RecipesState = ChatState;

export const recipesView: ExampleView<RecipesState> = {
  initial: CHAT_START,
  step: chatStep,
  render: (state, columns) => {
    const width = Math.max(columns, 1);
    return [
      `${bold("recipes")}  ${chatMark(state.session, "cooking")}`,
      ...state.entries.flatMap((entry) => drawChatEntry(entry, width)),
      ...chatFooter(state, width, "⏎ send · ^A watch the session · ^C quit"),
    ];
  },
};
