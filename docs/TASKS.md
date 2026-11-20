# Talos: where it's going

The plan for tasks, boards, templates and loops. None of this is built yet; it's the direction for what comes next.

**This is a brainstorm, and it follows the session design.** It came from
spitballing ideas with Claude. Its core ideas should stay, but its details change
as the session design (`talos-sessions`, see [MODULES.md](MODULES.md)) takes
shape. That design work comes first: where the two disagree, the session design
wins, and this file gets updated to match. The corrections so far are listed
below.

[github.com/joeboylson/talos](https://github.com/joeboylson/talos)

Start, watch and control Claude sessions on all your machines from one website.

## Lanes

- **Prose:** the open conversation where a session does its work.
- **Structured:** short messages with fixed fields, like a status update or a decision, that a program can read and act on.

## Corrections from the session design

These change the answers below. Where they disagree, these win.

- **Lanes are now one turn shape.** Every turn has an **output** it must give
  back, and **optional outputs** it may also send:
  `{ output: "prose", optional: ["decision"] }` for a normal turn, and
  `{ output: "status", optional: [] }` to ask for a status. Prose is one kind of
  output; the others are structured, of a **kind** like status or decision.
- **The kinds belong to talos, not the session module (87).** Everything in 87
  that a session "reports in a fixed format" becomes an output kind defined in
  talos's specific layer, with its own fields: blocked, waiting, finished,
  permission requests, sub-tasks, moving a task, dev comments, links. The
  session module itself knows no kinds.
- **Every output gets an id, and answers come back tied to it (8, 61).**
  - The session runner makes a fresh id during the tool call, and the session
    sees it in the tool's reply.
  - An answer goes back as `Answer to <id>: <answer>`, so any number of
    questions can be open at once. Talos presses Esc before typing it.
  - A question lasts one turn: it closes when the session's next turn ends.
  - The decision card shows only once the session's turn has really ended.
- **Commands only come through prose.** A field that gets typed into a session
  (like a decision's choices) must say whether it may hold a command (`/`, `!`,
  `#`, `@`). Fields that are only shown, like comments or notes, can mention
  anything.
- **Repeating prompts don't fit yet (13, 14).** A status turn may only give
  back its output, with no other tools. A repeating prompt has to do real work
  with tools, then hand back a required result kept outside the conversation.
  The turn shape needs to grow for this when loops get built.
- **Answers that aren't messages from a person (3, 16–18, 86).** These include a
  permission request, a blocked task answered by the session above it, and a
  finished sub-task. They come back the same way: tied to the output's id. They
  can come from talos or another session, not only from a person. The answer
  form needs to say who it's from when this gets built.
- **Names.** The program that keeps sessions running is the **session runner**
  (it was called the "host"), and talos on a machine relays between it and the
  server. See [GLOSSARY.md](GLOSSARY.md).

<!-- Q&A section: always keep this at the bottom of the page. -->

## Questions and answers

### 1. What is a task?

A work item that either a person or an agent can work on.

### 2. Where do tasks come from?

I create them, or an agent creates them when I ask it to.

### 3. How does a task get to whoever works on it?

- Every session can see every task, but can only work on tasks it has permission for.
- Tasks aren't assigned. Sessions are given permission to work on them.
- A session can ask me for permission to a task it can't work on yet.
- A session automatically has permission for any task it creates.
- Idea: give a session permission to a group of tasks, and I move tasks in and out of the group.

### 4. Can more than one session work on the same task at once?

- No, to keep things less confusing. One session works on a task at a time.
- To share the work, a session creates a sub-task and gives another session permission to it.

### 5. Who can give a session permission to a sub-task?

Any session with permission to a task can give permission to its sub-tasks, but not to the task itself. Only I give permission to the task itself.

### 6. How deep can sub-tasks go?

Three levels: task, sub-task, sub-sub-task. A session working on a sub-sub-task can't split it any further.

### 7. Example

1. I create a task, "Add a dark mode setting," and give Session A permission to work on it.
2. Session A builds it, then creates a sub-task, "Check the dark mode screens," and gives Session B permission to work on that.
3. Session B finds the colors are wrong in three places. It creates a sub-sub-task, "Fix the chart colors," and gives Session C permission.
4. Session C fixes the colors and finishes. It can't split the work any further.
5. Session B finishes its check, and Session A finishes the task.
6. Session A asks for permission on a related task, "Add dark mode to emails," and waits for me to approve it.

### 8. How does a session know when to create a sub-task, and who to give it to?

Each session has its own sub-task rules. Talos keeps them for reference and does not enforce them (see 10). Example:

```
session: builder
sub-task rules:
  - when: the build is finished
    create: "Check the work"
    give to: checker
  - when: a check finds problems
    create: "Fix what the check found"
    give to: builder

session: checker
sub-task rules:
  - when: a problem needs a small fix
    create: "Fix one problem"
    give to: fixer
```

### 9. Who decides a task is finished?

- It depends on the board. One board might only have "To do" and "Done." Another might add "In progress" and "In review."
- Each project has session rules, including what happens when a session finishes.
- When a session finishes, it can move the task to Done, move it to In review, add a comment, add a label, or any mix of these.

```
when a session finishes:
  - move to: In review
  - add comment: summary of what changed
  - add label: needs-check
```

### 10. Does Talos keep its own board, or use one from another tool?

- Talos keeps its own board, but it doesn't replace Jira or Linear. It works alongside them.
- The two can differ. A task can be Done in Talos while it stays in a review column in Jira until QA passes it. The session rules say how to handle this.
- Talos does not enforce rules. It keeps them for sessions and people to look up. People and sessions are each responsible for following them.

### 11. When a session finishes a task, does it pick up another?

- Only if a loop is running. With no loop, the session stops.
- A loop can be set to work through every task in a group, one after another.

### 12. What is a loop?

- A program that keeps a session moving.
- A loop runs over one of two things: a group of tasks, or a simple prompt.
- Each loop has rules for what it should do. For example: finish all the work the session has permission for, whether that's one group, several groups, or sub-tasks from other groups.

```
loop: clear my work
  session: builder
  work on: every task the session has permission for
  order: oldest first
  stop when: nothing is left
```

### 13. What happens when a loop runs out of work?

- The loop checks whether the session has any unfinished tasks. If it doesn't, the loop stops.
- A loop can also just repeat a prompt, with no tasks at all. Each run gives an output, and there's no progress to track.

```
loop: morning check
  session: helper
  prompt: "Check last night's errors and list anything new."
  every: weekday at 8:00
```

### 14. Where does a repeating prompt's output go?

- It's structured output, kept outside the conversation.
- The conversation might show a short note that the run started and finished, and nothing more.

### 15. Who reads a repeating prompt's output?

- Only the session that runs it, plus me on the page.
- If the session finds something that needs work, it creates a task. Tasks are how work gets shared, so other sessions don't read the output.

### 16. What happens when a session can't finish a task without something it doesn't have?

- Examples: it needs an answer from me, or it lacks access to something.
- The session finishes as much as it can first.
- Then it marks the task as blocked. The task stays in its current column (there's no "Blocked" column), and the block is shown to me.

### 17. Is waiting on a sub-task the same as being blocked?

- No. A session waiting on a sub-task is "waiting," not blocked.
- If the sub-task gets blocked, the session that holds the original task tries to unblock it by answering.

### 18. What if the session above can't answer either?

The block moves up a level each time, and reaches me at the top.

### 19. Can other people use Talos?

- Yes. I can turn on developer tools for each person. Without them, a person sees a plain task list and none of what sessions are doing.
- Example: my wife and I keep a personal list in Trello. Its columns are topics, not statuses, and tasks are just to do or complete. Talos has to work for that. Sometimes I want Claude to do one of those tasks, and she shouldn't have to learn any of it.
- Example: my dad and I have an app. He should be able to add tasks, but only I can use my machines, my sessions and my Claude account. He doesn't see the developer side.
- UI note: columns can be topics, not only statuses.

### 20. When someone else adds a task, who can hand it to a session?

- Only me.
- I can add it to a session's group, or give it straight to a session as a one-off.

### 21. When a session finishes someone else's task, what do they see?

- Just that the task moved.
- Comments can be marked "dev." Each board has a switch to show or hide dev comments for people without developer tools.
- Claude always posts its comments as dev comments.

### 22. Can people without developer tools see that a session is working on a task?

It's a board setting. By default, people without developer tools don't see it, so the task looks normal until it moves.

### 23. Who can create a board and invite people?

- Anyone who uses Talos.
- On my copy, only I can sign in for now. I'll add my wife and my dad later.
- Anyone who runs their own copy can open it up like any other app: anyone can sign in and sees their own boards and the boards they're added to.

### 24. Can someone else hand tasks to my sessions?

- No. Nobody else can hand tasks to my sessions.
- Each person owns their own machines, folders and sessions.

### 25. On a shared board, what if two people both want their sessions on the same task?

- Only one session can work on a task at a time, whoever owns it (see 4).
- Whoever hands it to a session first gets it. The other person sees it's taken and waits until it's handed back.

### 26. How is a task tied to tickets in Jira, Linear or other tools?

- It isn't tied to them, and nothing stays in step automatically.
- A task just has a list of links. One Talos task could point to ten Jira tickets.

### 27. Who updates a Jira ticket, like adding a comment or moving it to review?

- The session does, by following the session rules. It's purely rule-based.
- It depends on the tools the session's machine has. Talos has no built-in Jira connection, and won't.

### 28. Where do session rules live?

- Both on the board and on the session. A session's own rules add to its board's.
- A session's rules live in a **session template**, which outlives the session. I can stop a session and start a new one with the same template without rewriting anything.
- "Role" is only used for people, never for sessions.

### 29. What does a session template keep?

- Its rules, including sub-task rules.
- Which groups it has permission to.
- Its loop templates (see 76).
- How it works through tasks, and where tasks go when certain things happen.
- The instructions it gets when it starts.
- Which Claude model it uses.
- Settings for which tools it can use.

### 30. Can a machine use more than one Claude account?

Yes. A machine can have several Claude accounts, and switches to another when one hits its limit.

### 31. When a machine switches accounts, what happens to running sessions?

- It works like Janus: every open session moves to the new account without closing.
- One account is the main one. The machine moves to a backup when the main one passes a set share of its 5-hour or weekly limit, then goes back when the main one has room again.
- I can pick an account by hand and hold it there, then let it switch on its own again later.

### 32. Are Claude accounts tied to a machine or to a person?

- To the machine. Each machine has its own list of accounts.
- Example: my work machines can use my personal account, but my personal machines must never use my work account.

### 33. What if every account on a machine runs out?

Its sessions and loops pause and wait, then pick up again when an account resets.

### 34. What if a machine is off or loses its connection?

Its sessions keep their tasks until it comes back.

### 35. How does Talos tell me something needs me?

- On the page only for now. No phone notifications or messages yet.
- An inbox that's always on screen, in a corner, lists blocks, decisions and permission requests.

### 36. Who gets the inbox?

- Everyone. Each person chooses what they hear about.
- People with developer tools always hear about anything to do with their sessions. They can't turn that off.

### 37. Does every task keep a history?

- Yes, a full history: who created it, which sessions worked on it, when it moved, and so on.
- The history shouldn't grow forever. A removed task goes to the archive with its history, and both are deleted for good 30 days later (see 38).

### 38. What happens to finished tasks over time?

- Every board always has a Done column. The owner can rename it.
- Tasks in Done keep their history and stay.
- There's also an archive. Archived tasks and their history stay for 30 days, or until someone empties the archive by hand, like the trash on a computer.
- Archived tasks can be moved back into the columns.

### 39. What's the difference between Done and the archive?

- **Done** is just a column, and it can fill up.
- **Archive** is where a task goes when I don't want to see it anymore. There's no separate trash: removing a task means archiving it.

### 40. How do people find an old task?

Search within one board only.

### 41. What does a task hold?

A title, description, links, comments, labels, due date, attachments, sub-tasks, checklist, priority, the person who added it, the session working on it, and its blocked or waiting marker.

### 42. How does a group relate to a board?

A group belongs to one board, and only holds tasks from that board.

### 43. Can a task be in more than one group?

No, one group at a time.

### 44. Where do session templates live?

- In my own list, not under a board or group (see 52). A board picks which templates it uses.
- Several sessions can be opened on a board and given permission to several groups.

### 45. Can several sessions run from the same template at once?

Yes, but no two of them can have permission to the same group.

### 46. Can sessions with different templates share a group?

- No. One group, one session.
- If a group needs a builder and a checker, that team of agents runs under the one session, not as separate sessions side by side.
- Idea: bring Legion into Talos, so running a team of agents under a session is an option you turn on.

### 47. When a session runs a team of agents, does the team's work show on the board?

- No. Showing each step as a sub-task would get too messy. The board shows only the task and its status.
- With developer tools, I can open the session to see what the team is doing.
- The task keeps track of the team's runs (Legion calls them "missions"; the name may change).

### 48. Can one task have several missions?

Yes, one task can have many missions.

### 49. Does a session work alone or with a team of agents?

- The session template says which: alone, or with a team, and which team.
- A session can have only one team under it. The team is an extension of the session.
- Teams are set up like Legion's operators: each agent has its own definition.
- Setting up a session template should feel the same as setting up an agent on a team.

### 50. Where do team templates live?

In my own list, like session templates (see 52).

### 51. Can templates be reused on another board?

Yes. Any of my boards can use any template in my list, so there's nothing to copy.

### 52. Where do session templates and team templates live?

- I add them from a board, but they go into a list that belongs to me. Each board picks which ones it uses.
- Rules for one board only stay on that board (see 28).
- I can share a template with another person as a copy, not a live link, because their machines and accounts differ.
- A template doesn't save a machine or folder. I pick those when I start a session, so the same template works on any of my machines.
- If a template needs access to a particular folder, like one a tool uses, setting that up is up to me.

### 53. Can I start a session with no template?

Yes, a plain session with no template is fine.

### 54. Does every session belong to a board?

Yes, every session belongs to a board. It can only work on its own board's tasks, and only those it has permission for.

### 55. What happens to a session when it has nothing left to do?

It stays open and idle until I give it something.

### 56. What happens when a session's conversation gets too long?

Talos clears it and starts the session fresh with a short note on where it left off, like Legion does. The length limit can be changed.

### 57. Where is that length limit set?

In my user settings. A session can override it. Otherwise it uses my setting.

### 58. How do I keep an eye on several sessions?

- Not one screen of every session.
- Instead, a split window: the left side moves around the app, and the right side holds sessions I pin, as tabs.

### 59. Do pinned tabs stay?

They stay after a page refresh on the same computer, but don't follow me to other computers.

### 60. What does a pinned session tab show?

- The conversation.
- The groups it has permission to, and the tasks in them.
- A quick status of its team.
- Not the terminal, for now.
- Every section except the conversation can be hidden.

### 61. Where do a session's decisions show up?

Both: buttons in the session's tab, and a link to them in my inbox.

### 62. Can a session ask a decision of someone without developer tools?

No. People without developer tools never deal with Claude at all.

### 63. On a shared board, can two developers see each other's sessions?

No. Each person sees only their own sessions.

### 64. What can a developer see of another person's sessions?

That a task is taken by another person's session, and the dev comments it leaves. Nothing more.

### 65. Who decides who gets developer tools?

The board's owner.

### 66. What kinds of people are on a board?

- Owner, editor and viewer. Developer tools are a separate switch on top of those.
- An owner can make other people owners.
- An owner can't remove another owner.
- An owner can step down to a lower role only if there's another owner. The last owner can't step down.

### 67. Who can run sessions on a board?

Only people with developer tools on that board.

### 68. What happens when someone loses developer tools on a board?

- Their sessions on that board stop, and their tasks are handed back.
- Before the change, the person making it sees a warning listing exactly what will happen, and has to confirm.

### 69. Which changes get a warning and confirm step?

- Any change that affects more than the one thing being touched. Examples: removing someone from a board, archiving a group, deleting a session template.
- The warning says exactly what else will change, and the person must confirm.
- Wherever possible, the person chooses between doing all of it or part of it. Example: deleting a group asks whether to delete its tasks too, or only the group. Some changes, like turning off developer tools, are all or nothing.
- This is a pattern used everywhere, so people understand the system and what their actions mean.

### 70. Can a loop run on a schedule?

- Yes. Schedules use the cron format (the standard way computers write repeating times).
- The page has a simple picker for the schedule, and also lets me type a cron schedule directly.

### 71. What if a scheduled loop's machine is off when it's time to run?

The run is skipped. The skip is logged as a warning, and maybe sent to my inbox.

### 72. What if a loop's last run is still going when the next is due?

The new run is skipped. That's only noted in the loop's history, not raised as a warning or sent to me.

### 73. Can a loop have limits?

- Yes: a maximum number of runs, or an end date.
- Optionally, I get an alert when the limit is reached.

### 74. Must every loop have a limit?

Yes. Every loop must have one: at most 7 days, or at most 999 runs.

### 75. What happens when a loop hits its limit, and can it be changed while running?

- I can restart it.
- A loop can be edited while it's running (its prompt, its schedule, its limit, anything) without stopping it. Changes apply from the next run. The run already going isn't changed.

### 76. Where do loops come from?

- From **loop templates**: templates for a loop, following the same pattern as session templates.
- Loop templates belong only to session templates. A session template can have several.
- A session started from a session template can run one of its loop templates.
- Loops don't start on their own by default.

### 77. Can a session run more than one loop at once?

No, one loop at a time.

### 78. Can I type to a session while a loop is running?

Yes, like in Claude Code. The session answers when it's free.

### 79. How do my messages and loop runs share a session?

- Everything waits in one line, first come, first served. My messages are never skipped.
- First idea: when a loop run is due, it's skipped if a run from the same loop is already waiting or going (see 72).
- If that check isn't possible: the line holds at most five waiting messages. When it's full, I can't send a new message and loop runs are skipped. Keeping the loop from filling the line is then up to me.

### 80. What does a loop do when a task in its group gets blocked?

It moves on to the next task. The blocked one waits.

### 81. What if only blocked tasks are left?

The loop stops and tells me in my inbox that only blocked tasks are left.

### 82. In what order does a loop work through tasks?

Each loop template sets its own order as a rule (for example: as listed, by priority, by due date, or oldest first). If it doesn't set one, the loop goes top to bottom as listed.

### 83. Which group does a sub-task go into when it's given to another session?

No group. It shows up as a one-off in the other session.

### 84. Does a session's loop work on one-offs?

Yes, after its group's tasks. This may change later.

### 85. Can a session working on a sub-task see the task above it?

Yes, it can see the parent task.

### 86. When a sub-task is finished, does the session that created it find out?

- Yes, so it can pick its own task back up.
- It's not a message in the line, so it never counts toward the limit of five and can't be lost when the line is full.
- Instead, a loop checks for finished sub-tasks on each run. And whenever a session becomes free, Talos tells it which of its sub-tasks have finished.

### 87. What does a session report in a fixed format that Talos can read?

Status updates, decisions, being blocked, waiting on a sub-task, finishing (with a short summary of what changed), asking for permission, creating a sub-task, moving a task to another column, adding a dev comment, and adding a link.

### 88. Can a session edit a task's title, description or checklist?

Yes, it can edit all of those, on tasks it has permission for. That includes tasks other people added, even though they'll see the change.

### 89. Can I undo a change a session made?

- No undo for now. It gets messy.
- Something to look into: building everything from a running record of changes (event-driven), which could make undo easier later.

### 90. What should Talos not do?

- No built-in connections to Jira or other tools.
- No cost reports. There's nothing to report.
- No chat between people.
- No time tracking.
- No importing from Trello or other tools. Boards start fresh.
- A phone app is a maybe, far in the future.
- Maybe some light stats on Claude usage, just for fun. Build this last.

### 91. Can a task repeat on its own?

Yes, like "take out the trash every Tuesday," with no loop or session needed. Each time it comes due, Talos makes a fresh copy, even if the last copy isn't done.

### 92. Do people get reminders about due dates?

Yes, if they turn reminders on. Due dates are optional.

### 93. Can a task be assigned to a person?

- Yes, to one person at most. That person is who should do it and who gets its reminders.
- Assigning a person and giving a session permission are separate, so one doesn't block the other.

### 94. Should the page work on a phone?

Yes, it should work well on a phone. A nearer goal than a phone app: make the page installable on a phone's home screen (a PWA).

### 95. Should the inbox send phone notifications?

Yes, once the page can be installed on a phone. Notifications in general should be very configurable.

### 96. Are there task templates?

Yes. A template starts a task with a set checklist and labels already filled in. Sessions can use templates too, for example when creating several tasks at once.

### 97. Where do task templates live, and what are templates called?

- Task templates belong to a board.
- Everything of this kind is called a template: session templates, team templates, loop templates and task templates.

### 98. Can a board be made from a template?

No.

### 99. Can a task be moved to another board?

No.
