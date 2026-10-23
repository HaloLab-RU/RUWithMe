# Shared records

The `workspace/records/` folder is user content. Keep it with the workspace when backing up. It is separate from private `.ruwithme/` login/runtime/chat state. All stores start empty; do not import old content unless requested.

```text
workspace/records/
  commitments.json
  calendar.json
  days/                 YYYY-MM-DD.md, created only when a day is actually recorded
```

Persistent stores are indexed and validated. Calendar has a date agenda, a summary on Today and manual read-only Google synchronization. Todos and Today provide local task editing, scheduling and completion history. A planned work block can be explicitly published to Google through Codex. General imported-event editing, Outlook login, background synchronization and invitations are not implemented.

## Commitments

Envelope: `{version:1, revision:0, items:[]}`. Entries have a stable `id`, `title`, `category` (research/courses/learn/career/admin/personal, plus legacy other), `status` (open/in-progress/waiting/done/cancelled), and optional `ownerPath` referring to a folder or file in one of the six content spaces (research/courses/learn/career/admin/personal). Standalone commitments may omit ownerPath.

Optional fields: `person`, `deliverable`, `waitingOn`, `dueDate` (YYYY-MM-DD), `dueAt` (explicit-offset ISO instant, with timeZone), `followUpDate` (YYYY-MM-DD) and `notes`. Use dueDate for a date-only deadline or dueAt for an exact deadline, not both. Preserve a stable ID when editing; never infer completion from dates, meetings or files.

Deadlines displayed on Calendar will be derived from commitments, rather than copied into events. Calendar entries are scheduling facts and do not themselves create commitments.

## Calendar

Envelope: `{version:1, revision:0, timeZone:"America/New_York", sources:[], events:[], workBlocks:[]}`.

- `sources`: stable id and provider `google` or `outlook`. A Google source includes account (primary calendar identity), calendarId, title, timeZone, lastSyncedAt and a bounded window `{startAt,endAt}`. These are scheduling metadata, not credentials. OAuth clients, tokens and OAuth state belong outside this file in private runtime storage. No account is connected by default.
- `events`: appointments, class meetings, office hours and other fixed events. Each has id, title, status (`confirmed`, `tentative`, `cancelled`), timeZone and allDay. Timed events use startAt/endAt as explicit-offset ISO instants. All-day events use startDate/endDate with the end date exclusive, without startAt/endAt.
- Imported Google or Outlook events additionally carry sourceId and a stable sourceEventId per occurrence. They are source-owned; RUWithMe must not silently overwrite their times or infer cancellations from absence. Preserve per-occurrence exceptions and explicit cancellations.
- `workBlocks`: RUWithMe-owned planned work, with id, title, startAt, endAt, timeZone, status (`planned` or `cancelled`), optional ownerPath and commitmentId. These are intentions, not actual work. Moving a block must not move the linked deadline or change an Outlook event.

Google is the first read-only integration in this new workspace. Outlook support remains a separate future integration. External event writes require a dedicated publish/edit flow; they are not part of this interface.

## Days: plan and actual work

Create `days/YYYY-MM-DD.md` only when the user saves that day's choices or work. A day may contain separate `## Plan`, `## Actual work`, `## Blockers` and `## Next session` sections. Plans can reference commitment IDs and owner paths. Actual entries should retain the user's stated activity, conclusion, relevant files, and duration only if supplied or actually measured.

Do not create empty daily files just because time passes. History reads actual saved entries; file modification times and elapsed calendar blocks are not evidence of work. Today combines saved choices, commitments and calendar items; it does not need a duplicate task database.

## Maintenance

The index returns these records under its `records` property and includes them in change detection. Reads never initialize, overwrite or repair user files. Unsupported versions, malformed JSON, ambiguous time values and symlinked stores are rejected explicitly.

Google sync and the Todo scheduling/publication APIs write the calendar through revision-checked local APIs. It takes a cooperating-writer lock, validates the entire result and atomically replaces the store. Todos provide bounded editing of Todo records; unrelated commitments are preserved. Before any future editing API is added, require an expected revision and preserve unrelated records and fields. Do not place secrets in records.

## Google Calendar through Codex

The default connection is the user's existing Google Calendar connector inside Codex. **Calendar → Sync with Codex** uses the same local Codex app-server as Daily. No independent Google Cloud OAuth client JSON, app-specific Google password/token, model API key or new ChatGPT thread is required from the user. The app checks the connector's installed, enabled and callable state, then verifies account identity and readable calendars. A loaded Daily thread supplies MCP context; sync does not start an inference turn or add a chat message.

The supported app-server RPCs are `app/installed`, `app/read`, and `mcpServer/tool/call`. The Sync path allowlists only `google_calendar.get_profile`, `google_calendar.list_calendars` and `google_calendar.search_events`. Its browser API cannot select arbitrary MCP tools or invoke Google writes. Existing connector policies still apply. If access is missing or denied, reconnect or adjust the Google Calendar plugin in Codex; the app never silently falls back to another account or OAuth transport.

Sync is manual: choose 1–10 calendars and click **Sync with Codex**. It pages through every result in a rolling UTC-bounded window from 30 days before today through 180 days after today. Connector event IDs remain stable per source/occurrence. Normalization supports connector date strings for all-day events and explicit-offset timed events, and retains recurrence occurrence identity. All-day end dates remain exclusive. A connector can return date boundaries as offset-free midnight strings; a pair of midnight boundaries with a later end date is retained as dates with sourceDateEncoding=connector-midnight. The UI calls these Date and links to Google for checking; no offset is invented. Non-midnight floating times fail validation and preserve the prior snapshot. If the connector calendar list omits its timezone, the workspace's display timezone is used; timed instants retain their original offsets. Raw connector responses, profile pictures, event descriptions and organizer/attendee data are not saved to workspace. Only the scheduling projection is saved.

Each successful sync replaces only the selected calendars' bounded event projections. This is a refreshable cache, not a permanent Google event archive. Events outside this window are not downloaded or promised as history. Missing events leave the refreshed projection; they are not fabricated as cancellations. Explicit cancellation tombstones retain known occurrence dates/identity when available. Other calendars, local events, work blocks, commitments, Inbox content and actual daily history remain intact. Unselected calendars can retain older cached projections; the UI labels them as cached. Each source retains its own successful timestamp and coverage window. A failed page, revoked access, malformed event, mid-sync account switch or revision conflict preserves the prior snapshot.

Only the chosen calendar IDs and matching account identity are kept under private `.ruwithme/calendar/preferences.json` (0600). Google credentials remain managed by Codex and are not read or copied by RUWithMe. The earlier direct-OAuth adapter is not the default server transport and its setup/authorize/disconnect routes are unavailable through the default app.

Local endpoints (same application origin):

- `GET /api/calendar/google/status`: verified connector state (`via: "codex"`), readable calendars, current selection and whether update tools are available. No credentials.
- `POST /api/calendar/google/calendars`: re-check the Codex connection and refresh readable calendar metadata.
- `POST /api/calendar/google/sync`: `{calendarIds: [...], expectedRevision: currentCalendarRevision}`. A successful response includes `via: "codex"`, revision, timestamp, event count and window.

All POSTs require JSON, exact local `Origin` and `X-RUWithMe-CSRF`. Daily can read the token from `GET /api/codex/session` into memory without printing it, read `GET /api/workspace` for the current revision, and call Sync when requested. Never fabricate events when disconnected, take a client-provided snapshot as source truth, or silently retry a revision conflict using a newer revision.

## Google event changes

Sync is read-only, even if the connector also supplies write tools. A Google event change requires a separate explicit user request naming the event and change. Daily must read the original, preserve unrelated fields/guests, respect the requested recurrence scope, apply the change through the connected Google tool, then re-read Google to verify the outcome before refreshing the local snapshot. Pending or failed external writes must not be represented as successful local changes. Imported-event drag/edit forms and a general event-write HTTP API are not implemented. Todo work-block publishing has its own reviewed creation flow and durable publication state. An event's Google link opens its original for direct editing there.

Reference: [Codex app-server connector and MCP support](https://learn.chatgpt.com/docs/app-server).

## Todos, Today and work blocks

Todo entries share `commitments.json` with other commitments, distinguished by `kind: "todo"`. They have the normal commitment identity/title/category/status/deadline/owner fields, plus per-item revision, createdAt, updatedAt, completedAt, `todayDates: [YYYY-MM-DD]` and `history: [{id, action: "completed" | "reopened" | "cancelled", at}]`. The whole store retains its own revision. Reads remain compatible with existing non-Todo commitments. A Todo uses a date-only dueDate in this version; no deadline or completion time is inferred from its title.

In synthetic mode, new Todo transitions also save `synthetic: true` and `workDate: YYYY-MM-DD` from the current scenario date. Track groups those transitions by their explicit work date; `at`, `completedAt` and `updatedAt` remain the real audit instants. Detail views show the recorded instant separately. Real and legacy histories without a synthetic work date keep their original timezone-based grouping, and leaving demo mode does not rewrite earlier history.

`+ Todo` is available from every screen. The editor supports an optional deadline and an owner in any of the six content spaces. Today uses explicitly selected dates in the workspace's configured timezone; old selections are retained. Unfinished items stay in Todos when a new day begins. Completed items move to the Completed tab; reopening retains previous completion history. Completion records actual user actions, not elapsed blocks. No daily Markdown file is created by ticking a checkbox.

Schedule creates a distinct `calendar.workBlocks` entry referring to the commitmentId, with explicit-offset startAt/endAt and the workspace IANA timezone. A Todo may have multiple blocks. Local date/time inputs reject nonexistent or ambiguous DST times. Scheduling checks both the Todo-store revision and Calendar revision. Completing or reopening a Todo does not mutate its deadline, calendar blocks, imported Google events or original files. Cancelling an unpublished block preserves it with status cancelled.

Todo APIs require local Origin, JSON and the session CSRF token:

- `POST /api/todos/create`: `{requestId: UUID, expectedRevision, title, category?, dueDate?, ownerPath?, addToToday?}`.
- `POST /api/todos/update`: `{id, expectedRevision, title, category?, dueDate?, ownerPath?}`.
- `POST /api/todos/today`: `{id, expectedRevision, selected: boolean}`; the server chooses today's date using the workspace timezone.
- `POST /api/todos/complete`: `{id, expectedRevision, done: boolean}`; completion and reopening append history only on a state transition.
- `POST /api/todos/schedule`: `{id, requestId: UUID, expectedRevision, expectedCalendarRevision, startLocal: "YYYY-MM-DDTHH:mm", endLocal: "YYYY-MM-DDTHH:mm"}`.
- `POST /api/todos/cancel-block`: `{id: blockId, expectedCalendarRevision}`; rejects Google-linked blocks.

Todo creation and scheduling request IDs prevent duplicate identities. Mutations serialize with cooperating-writer locks, validate the entire store, reject stale revisions and atomically replace the target JSON. Scheduling holds the Todo lock while committing its Calendar change, so a concurrent completion cannot invalidate a checked task mid-write. On conflict, preserve the draft and require the user to inspect the latest state before rebasing. Do not edit these JSON stores directly through Daily.

## Publish a Todo work block to Google

`Add to Google Calendar` shows the block title, dates/timezone, account and a writable target-calendar selector. `Confirm & add to Google` is a separate action from saving a local Todo or work block. It creates one personal event through Codex with no invited attendees, self attendance omitted and Google Meet disabled. No existing Google event is edited or deleted. Google tools/policies still control whether the action is allowed.

- `POST /api/todos/publish`: `{id: blockId, operationId: UUID, expectedCalendarRevision, account, calendarId, confirmed: true}`. The server re-checks the account and writable calendar; browser-supplied titles/times/attendees are ignored in favor of the saved block.
- Before invoking create_event, the server saves a durable google publication record on the work block: operationId, account, calendarId/calendarTitle, marker, startedAt and state publishing. A returned eventId is saved before verification. Only a successful read-back matching title and exact instants sets state published and verifiedAt.
- Tool failure, lost responses or uncertain verification retain the publication record and disable another create. `POST /api/todos/check-google` with `{id: blockId}` reads the known eventId, or pages through the saved bounded window looking for the exact unique work-block marker, then verifies the result. It never retries creation automatically. A crash leaving publishing/verifying is reconciled the same way. Ambiguous/missing matches require checking Google; existing remote edits are not overwritten.
- Published blocks keep their Google identity/link. Calendar rendering shows one occurrence when a later Google sync also imports that event; the local Todo and original work-block relationship remain saved.

Publishing does not mark a Todo complete, and completion does not remove the Google event. The in-app flow and uncertain-result recovery are tested with an isolated simulated connector; no test event is created on the real Google account during implementation.

## Personal category compatibility

New Todo forms use category `personal`, matching the `personal/` content root. The previous `other` category remains valid and displays as Personal; existing records are not rewritten when read. An explicitly created/edited legacy `other` Todo may link to an owner under personal/. New owner paths may also reference Career or Admin areas. Task/category owner validation and safe file access apply consistently to all six roots. These are content spaces in the same workspace, without separate commitment or calendar stores.

## Track Commitments

Active Commitments and Todos render as compact cards. Completed/cancelled records use bounded, keyboard-scrollable one-line lists; select a title to see full details. Deleted is a separate filter, with Restore and a recent-delete Undo action.

`POST /api/commitments/delete`, `/api/commitments/restore`, `/api/todos/delete` and `/api/todos/restore` accept `{id, expectedRevision}`. They use the same shared transaction lock, exact Origin/CSRF checks and optimistic store revision as other task writes. Delete moves the complete record from `items` to optional `trash`, adding `deletedAt` and advancing revisions; restore moves it back and removes `deletedAt`. Missing `trash` means empty, so existing version-1 stores need no migration. IDs are unique across live and deleted records. Creating an already deleted ID is rejected; restore it instead. Retrying a completed move with the latest store revision is a no-op.

Deletion is reversible and local. It removes the record from active/closed lists, Today, linked task lists and derived deadlines. It does not rewrite completion/status history, project files, sessions, confirmed Track entries, Calendar work blocks or external Google events. Stored work blocks and Google publication receipts retain their identities and can still be inspected in Calendar. Deleted records must not be counted as active responsibilities in Daily planning.

`POST /api/todos/cancel` accepts `{id, expectedRevision}`. It records a `cancelled` history action and closes the Todo without claiming completion. Reopen via `/api/todos/complete` with `done:false`; the original deadline and Today choices remain stored.

Track → Commitments provides the full manager for non-Todo responsibilities across all dates. Today displays brief delivery and waiting summaries. New entries use `kind: "commitment"`, a UUID, per-item revision, createdAt/updatedAt, optional completedAt and `history: [{id, action: "status-changed", from, to, at}]`. Title and deadline date are required on create/edit. Optional dueTime is interpreted in the workspace Calendar timezone and stored as dueAt with timeZone instead of dueDate; DST gaps and folds are rejected. Optional person, deliverable, waitingOn and ownerPath describe the responsibility. Existing untyped commitments remain readable/editable; unrelated fields are preserved.

- `POST /api/commitments/create`: `{requestId: UUID, expectedRevision, title, dueDate, dueTime?, category?, ownerPath?, person?, deliverable?, waitingOn?, status?}`; initial status open, in-progress or waiting.
- `POST /api/commitments/update`: same editable fields with `{id, expectedRevision}` instead of requestId; optional status may also be done/cancelled. Edits and any state transition save atomically.
- `POST /api/commitments/status`: `{id, expectedRevision, status}`; open, in-progress, waiting, done or cancelled. Completion records an explicit timestamp; reopening retains history and clears completedAt.

All endpoints require exact local Origin, session CSRF and bounded JSON. They share the same store revision and cooperating lock as Todos, reject stale revisions, and never mutate Todo records. On conflict the UI preserves the form and requires inspection before rebasing. The card has Active and Completed / Cancelled views, editing, completion/reopening and status history. Calendar derives open deadlines directly from shared records; no duplicate event, Google write, Today selection or daily history file is created by saving a commitment. Use these APIs for Daily commitment changes; never rewrite commitments.json directly.

## Track: discussed plans, actual reviews and confirmation

Navigation uses Track in place of Todos. `#track` contains the day's confirmed plan/review and selected Todos, `#track/todos` retains the full Todo workflow, and `#track/history` reads confirmed versions, explicit task completion/reopening actions and existing `records/days/YYYY-MM-DD.md` notes. `#todos` remains a redirect. No original Todo or daily note is migrated or replaced. Dates use the workspace Calendar timezone; future/past days can be viewed, while the generation buttons start today's workflow only.

`records/track.json` is the structured source for these new workflows: `{version:1, revision, drafts:[], entries:[]}`. Reading an empty Track creates no files. Pending/discarded drafts are proposals, never confirmed records or actual work. Each draft has id, date, type (plan/summary), timeZone, content, revision, status (pending/saved/discarded), createdAt and updatedAt. Each confirmed entry is an immutable copy with its own id, draftId, draftRevision, confirmedAt and confirmation method (button/chat). Re-discussion after saving creates a new draft and accepted version, preserving old confirmed entries. Existing Markdown work notes remain readable alongside these records.

Plan content is `{priorities: string[], schedule: string[], notes: string}`. The plan records suggested priorities/arrangements only; even user acceptance never creates Todos, moves deadlines, changes Google, or proves completed work. The user creates actionable Todos manually. Summary content is `{completed: string[], unfinished: string[], blockers: string[], oneLine: string}`; all three lists are required and the last field is one nonempty line up to 500 characters. The evening skill asks for missing actual-work reports instead of deriving attendance/results from Calendar or file timestamps. An empty list means the user verified there were no items in that category.

Local APIs require exact Origin, bounded JSON and session CSRF for every POST. Obtain csrf in memory from GET /api/codex/session and never print its response/token.

- `GET /api/track` returns the Track store plus today/timeZone and latestUserMessage (id, role, text, time) from the existing Daily conversation, allowing confirmation without reading private session files.
- `POST /api/track/start`: `{type: "plan"|"summary", date: today, requestId: UUID}`. Invokes the same Daily thread/subscription with the selected project skill. The app does not generate a canned plan/review, create a new chat, or write a record on button press. If Codex is unavailable or busy, no saved Track entry is invented.
- `POST /api/track/propose`: `{requestId: UUID, expectedRevision, date, type, content}` stages a pending draft. For an edit, also include `{id, expectedDraftRevision}`; date/type are immutable. A new draft supersedes pending drafts of the same type/day, retaining their discarded state. A saved draft cannot be edited.
- `POST /api/track/confirm`: `{id, expectedRevision, expectedDraftRevision, confirmationMessageId}` is Daily's confirmation path. The ID must match the latest real user message, an explicit save phrase such as Confirm and save, and a message timestamp at or after the last draft update. Corrections require a revised draft and new confirmation. Ambiguous approval should use the review button. Daily must never pass confirmed:true. The browser review button sends `{id, expectedRevision, expectedDraftRevision, confirmed:true}` and is unavailable during an active Daily turn. Both paths atomically append one confirmed entry and mark the draft saved. Repeated acceptance cannot duplicate entries.
- `POST /api/track/discard`: `{id, expectedRevision, expectedDraftRevision}` soft-discards only a pending draft. Confirmed history is not removed.

Daily uses the local `ruwithme_daily` stdio MCP server for planning/review: `read_records` returns `{workspace, track}` from GET `/api/workspace` and `/api/track`; `propose_track` forwards the documented proposal fields; `confirm_track` forwards only the chat-confirmation fields and requires `confirmationMessageId`. The server handles exact Origin and CSRF internally; tools never return the session or token. This preserves the API's revision and consent checks without shell HTTP requests or network permission escalation. It is configured only for RUWithMe's app-server process and does not change the user's global Codex settings, command sandbox, Google data or calendar synchronization.

All Track mutations share one cooperating lock and optimistic store revision, validate the full record store and atomically replace only track.json. Stale revisions are rejected; preserve suggestions and inspect the latest draft before retrying. Never reset corrupt stores or silently overwrite original notes. Do not write track.json or days Markdown directly for these workflows.

Project skills live in `.agents/skills/ruwithme-morning-plan/SKILL.md` and `.agents/skills/ruwithme-evening-summary/SKILL.md`, following the [official skill format](https://learn.chatgpt.com/docs/build-skills). They are part of this RUWithMe project. No recurring automation or background model generation is enabled.

## Work sessions

`workspace/records/sessions.json` stores `{version:1, revision, items:[]}`. A session has a UUID `id`, `date`, `timeZone`, optional `ownerPath` pointing to an existing workspace README, `workedOn`, `outcome`, `blockers`, `nextStep`, existing workspace-file references in `files`, `revision`, `createdAt`, `updatedAt` and `versions`. `workedOn` is required; optional text may be empty. These are user reports, not automatically inferred progress. Old versions are corrections of the same session, not additional work.

`GET /api/sessions` reads the store. `POST /api/sessions/save` accepts `{id, expectedRevision, date, ownerPath, workedOn, outcome, blockers, nextStep, files}`; editing also requires `expectedItemRevision`. Use exact Origin, JSON and X-RUWithMe-CSRF. Writes are serialized, revision-checked and atomic; errors preserve original records. An identical create retry returns the saved session without duplication. Future work dates, unknown owners, private file paths and workspace escapes are rejected. Existing source files and project README remain unchanged. Reads of a missing store are empty without creating a file.

The workspace index exposes `records.sessions`; Daily receives relevant latest versions as context, and `ruwithme_daily.read_records` exposes the full saved set for review. Sessions appear by owner in workspace details and by work date in Track/History.

## Weekly Track reviews

Track type `weekly` uses a Monday `date` and `{progress:string[], unfinished:string[], blockers:string[], nextWeek:string[], oneLine:string}`. Monday–Sunday dates use calendar arithmetic in the workspace timezone, not fixed 168-hour UTC intervals. `POST /api/track/start` accepts `{type:"weekly", date:ANY_DAY_IN_WEEK, requestId}`; prior/current weeks are supported and future weeks rejected. The selected skill receives the week range and as-of date. A current-week review cannot claim future work happened.

Weekly drafts use the existing propose/confirm/discard endpoints, expected revisions and explicit later chat/button confirmation. A correction requires another review. Confirmed versions are retained in Track History; the review does not create Todos or change commitments, Calendar, research priorities or project context. There is no scheduled weekly job.

## Local English calendar titles

Imported event `title`, identity, dates, status, source URLs and timestamps remain source-owned. An optional `displayTitle: {language: "en", sourceTitle, text}` supplies a local English presentation; sourceTitle must exactly match title. Calendar, Today and Daily page context use that translation. Context labels the original wording separately. Sync retains the local translation only while the source title is unchanged; a renamed source event drops the stale translation. This metadata does not rename an event in Google or imply a new schedule, completion, confirmation or external write.

## Linked actions and effort

Todo create/update additionally accept optional `parentCommitmentId` and `estimateMinutes` (null or an integer from 5 through 1,440). A parent identifies a non-Todo responsibility. New links require an available parent; existing links survive local deletion of the parent. Action deadlines remain independent and are never inherited silently. Completing all linked actions does not complete the responsibility. Estimates represent intended effort, not actual work. Ordinary record writes still require the current shared store revision.

## Local Calendar events

`POST /api/calendar/local/save` accepts `{id?, expectedRevision, title, location, ownerPath?, allDay, startLocal?, endLocal?, startDate?, endDate?}`. Timed values are local `YYYY-MM-DDTHH:mm` in the Calendar timezone; DST gaps/folds are rejected. All-day values use dates and an exclusive endDate. A missing id creates a local event; an existing local event id edits it. `{id, expectedRevision, cancel:true}` retains it with cancelled status. Imported source-owned events are rejected. Local writes do not modify Google/Outlook, create invitations, complete tasks or claim attendance. Origin, CSRF, JSON size and atomic revision checks apply.

## Materials

`POST /api/materials/upload?ownerPath=...&name=...&folder=files|notes` accepts the original binary bytes as `application/octet-stream`, up to 32 MiB. Owners must be real canonical workspace folders. Existing destination files, hidden paths and symlink redirections are rejected.

`POST /api/materials/file-inbox` accepts `{path, ownerPath, folder, expectedSize, expectedModified}`. It copies a directly contained Inbox file after checking its observed size/mtime, retains the source and all existing references, and records `{sourcePath, path, ownerPath, filedAt}` in protected `inbox/.filings.json`. This is deliberately a copy-with-receipt flow rather than a move that could break session/file references. Reads expose each Inbox entry's filedTo receipts. Filing is local and does not infer research progress.

## Synthetic scenario provenance

A protected `workspace/.demo.json` manifest marks academic sample content and supplies scenarioDate. In this mode, Today selection, Track generation and work-session date validation consistently use that sample date. Seeded task/session/Track rows carry `synthetic:true`; synthetic Track confirmations are labelled examples in the UI. Never treat them as evidence of the user's actual work. Refreshing/starting the app never creates new example activity. New proposals still require a separate explicit confirmation.

Sample work blocks cannot be published through the Google publication API, and the sample Calendar does not discover or sync external sources. The reset script is a separate, explicitly invoked maintenance operation with staging, validation, backup and rollback; ordinary Daily record operations must continue using the APIs above.
