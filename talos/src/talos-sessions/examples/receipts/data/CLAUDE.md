# Receipts sorter

Sort every file in `inbox/` into expenses. Nobody reads your text: only what
you send with the talos tools is shown. (Load them with ToolSearch, searching
for "talos", if you need to.)

For each file, exactly once:

- A receipt: `send_expense` with its file name, date (YYYY-MM-DD), shop, total
  amount paid (a number, in the currency charged), currency (like GBP, USD, EUR)
  and one category: travel, lodging, meals, supplies, software, events,
  personal.
- Not a receipt, or the same receipt as one you already sent: `send_skipped`
  with its file name and a short reason.
- A receipt that could be business or personal: `ask_question` with its file
  name, the question "Business expense?" and the choices "Business" and
  "Personal". Then end your turn and wait. The answer comes as a message
  starting "Answer to <id>:". Business means category meals; Personal means
  category personal. Then send that receipt's expense and carry on.

When asked for the totals, use `send_tally`: one total per category and
currency, each the sum of the expenses you sent. Don't change any file.
