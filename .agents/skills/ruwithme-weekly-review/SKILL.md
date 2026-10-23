---
name: ruwithme-weekly-review
description: Discuss a RUWithMe weekly review using saved work sessions, confirmed daily reviews, commitments and calendar constraints; stage and save a Track review only after explicit user confirmation. Does not schedule, create Todos or change priorities.
---

Use the supplied Monday start date, Sunday end date, as-of date and timezone. The current week is an interim review through today; future days are not completed work. For a past week, current task state alone cannot establish its historical state. Read RECORDS.md when API details are needed.

Use the configured `ruwithme_daily.read_records` MCP tool. It returns `{workspace, track}`. Review `workspace.records.sessions.items` for user-reported work in the chosen date range, `workspace.records.track.entries` for confirmed daily reviews, original day notes, explicit Todo/commitment histories, and relevant source notes in the workspaces. Use each session's latest version once; its `versions` are retained corrections, not additional work. Check recorded research priorities and pending commitments without changing them. Calendar snapshots provide time constraints and sync coverage, not proof of attendance or progress. Read relevant project notes with normal file access; do not infer progress from file timestamps.

For Todo histories explicitly marked `synthetic: true`, use their optional `workDate` to place completion, reopening or cancellation in the demo week. Their `at` and `completedAt` values remain real audit timestamps. Histories without that explicit synthetic work date use the audit date in the supplied timezone. Preserve reopening/cancellation history rather than counting every completion action as a distinct finished task.

Discuss in English: what actually moved forward, what remains unfinished, blockers/waiting, whether research received the intended attention, and a realistic direction for next week. Distinguish user-confirmed results from tentative interpretations. If the sources lack evidence of actual work, ask what the user did and where they got stuck before staging a factual review. Missing logs do not mean no work happened. User-chosen priorities stay intact; next-week directions are advice, and the user creates Todos manually.

Show the review in Daily and stage the same content with `ruwithme_daily.propose_track`:

`{requestId: UUID, expectedRevision, date: MONDAY_START, type: "weekly", content: {progress: string[], unfinished: string[], blockers: string[], nextWeek: string[], oneLine: string}}`.

All four lists are required. `oneLine` is a nonempty single sentence/line up to 500 characters. Use factual uncertainty explicitly; do not invent research conclusions, attendance, output counts or time spent. To revise a draft include `{id, expectedDraftRevision}` with current revisions. Preserve the user's proposal on conflicts; never blindly retry a newer revision. Staging does not save a confirmed record.

Invite corrections. Save only after a later explicit **Confirm and save** message or the review button. For chat confirmation, call `read_records` again and `ruwithme_daily.confirm_track` with `{id, expectedRevision, expectedDraftRevision, confirmationMessageId: track.latestUserMessage.id}`. Confirm only the latest unchanged reviewed draft. A correction requires a revised draft and new confirmation. Never pass the browser-only `confirmed:true` or infer consent from silence. Read back the confirmed entry before claiming success. Older confirmed versions remain in History.

These tools handle local Origin and CSRF internally. Do not request shell network/escalated execution permissions, inspect session credentials or write Track JSON directly. Do not create Todos, complete tasks, alter commitments or project priorities, synchronize calendars or change external services as a side effect. If a tool is unavailable, preserve the draft and report the connection issue.

If the workspace contains a synthetic demo manifest, use its scenario date and explicitly call the seeded activities, findings and confirmations examples. Do not present them as the user's actual work. Courses are maintained manually; do not request Canvas access or sync. Linked Todo actions support a parent Commitment but do not establish final delivery. Effort estimates and calendar work blocks are intentions, not evidence of time actually worked. Keep the same user-confirmation boundaries in sample mode.
