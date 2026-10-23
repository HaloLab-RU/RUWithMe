---
name: ruwithme-evening-summary
description: Discuss an evidence-based evening review in RUWithMe Daily, covering completed work, unfinished work, blockers and a one-sentence summary; save to Track only after user confirmation.
---

Use the RUWithMe-supplied date, timezone, content root and local origin. Read the project's RECORDS.md for Track API details. Use the configured `ruwithme_daily.read_records` MCP tool (shown as `mcp__ruwithme_daily__read_records` when namespaced); it returns `{workspace, track}` with revisions and the latest real user message. Read today's accepted plan, Todo completion/reopening history, saved daily work notes, and relevant workspace history; read source notes with normal project file access. Calendar events, elapsed work blocks, changed files and an unchecked Todo do not establish attendance, completed research, failure or a blocker.

Reconcile evidence with the user in Daily. If there is no adequate actual-work report, first ask what they worked on, what remains, and where they got stuck; do not fabricate a polished summary. Preserve partial progress and unplanned work. A completed Todo establishes the user's completion action, not an invented scientific result. Distinguish unfinished work from waiting for another person, and ask about unclear status. Do not mark tasks complete, carry tasks to tomorrow, change Calendar, create Todos, or add project progress as a side effect.

Use today's user-reported sessions from `workspace.records.sessions.items`, including outcomes, blockers and next steps. Read each session's latest version once; its retained `versions` are corrections, not extra completed work. Discuss any gaps between those logs and the user's account.

For Todo histories explicitly marked `synthetic: true`, use their optional `workDate` to place completion, reopening or cancellation in the demo day. Their `at` and `completedAt` values remain real audit timestamps. Histories without that explicit synthetic work date use the audit date in the supplied timezone. Reopening is not completion; preserve the sequence and the current task state.

Produce a concise review with four parts: **Completed today**, **Unfinished / Partly completed**, **Blockers / Waiting**, and **One-sentence summary**. Base each actual claim on user reports or saved evidence. Surface uncertainty as such; do not convert a proposed plan into actual work. Offer next-session suggestions within unfinished items if useful.

Show the full review in Daily and stage that same content with `ruwithme_daily.propose_track` (backed by POST /api/track/propose):
`{requestId: UUID, expectedRevision, date, type: "summary", content: {completed: string[], unfinished: string[], blockers: string[], oneLine: string}}`.
oneLine is a single line, up to 500 characters; all three lists must be present. Empty lists mean the user confirmed no items in that category, not that missing evidence was guessed away. To revise a pending draft include `{id, expectedDraftRevision}`. Read current revisions first and preserve the draft on conflicts. Staging is not confirming.

Ask the user to discuss corrections, reply **Confirm and save**, or press **Confirm and save** on the draft. On a later explicit confirmation, call `read_records` again and `ruwithme_daily.confirm_track` with `{id, expectedRevision, expectedDraftRevision, confirmationMessageId: track.latestUserMessage.id}` for the latest reviewed draft. Never use `confirmed: true` from Daily, infer consent from silence, or save on the same turn that first proposes/revises the content. If approval includes a correction, revise and show the result for confirmation again. Verify the saved entry through `read_records` before reporting success; saved versions remain in History.

The tools handle Origin, CSRF and HTTP inside the app; do not use shell HTTP calls, request network/escalated execution permissions, or read session credentials for this workflow. If the tools are unavailable, report the connection problem and preserve any draft. Never write track.json or daily Markdown directly. User-confirmed summary records are distinct from plan suggestions and task state.

Write the conversation, draft content, and confirmed record in English by default. Preserve proper names and original source quotations; change the output language only on an explicit user request.

If the workspace contains a synthetic demo manifest, use its scenario date and explicitly call the seeded activities, findings and confirmations examples. Do not present them as the user's actual work. Courses are maintained manually; do not request Canvas access or sync. Linked Todo actions support a parent Commitment but do not establish final delivery. Effort estimates and calendar work blocks are intentions, not evidence of time actually worked. Keep the same user-confirmation boundaries in sample mode.
