# MCP tools and examples

All examples contain placeholders. They are request shapes, not commands to run
against a live account. Use `accounts_list` and calendar discovery to obtain IDs.
Tool schemas are authoritative for bounds and validation.

## Tool surface

| Tool | Principal inputs |
|---|---|
| `accounts_list` | None; lists IDs, email and granted scopes |
| `gmail_search` | `accountIds`, `query`, optional page limits and `continuations` |
| `gmail_read_message` | `accountId`, `messageId` |
| `gmail_read_thread` | `accountId`, `threadId`, optional `maxMessages` |
| `gmail_read_attachment` | `accountId`, `messageId`, exactly one of `attachmentId` or `partId` |
| `gmail_create_draft` | `accountId`, `requestId`, structured recipients, `text`, subject or reply source |
| `calendar_list_calendars` | `accountId`, optional `pageSize`, `cursor` |
| `calendar_list_events` | `accountId`, `calendarId`, search/time/expansion options, pagination |
| `calendar_get_event` | `accountId`, `calendarId`, `eventId` |
| `calendar_list_instances` | `accountId`, `calendarId`, series `eventId`, time window, pagination |
| `calendar_free_busy` | Selected `calendars` account/calendar pairs and time window |
| `calendar_find_availability` | The same pairs/window plus `durationMinutes`, optional `maxResults` |
| `calendar_create_event` | `accountId`, `calendarId`, `requestId`, `sendUpdates`, `event` |
| `calendar_update_event` | Same routing/policy, `eventId`, `scope`, `changes` |
| `calendar_delete_event` | Same routing/policy, `eventId`, `scope`; always requires approval |
| `calendar_rsvp` | Same routing/policy, `eventId`, `scope`, `responseStatus`; self only |
| `operation_status` | `accountId`, `operationId` |
| `operation_cancel` | `accountId`, `operationId`; no rollback after dispatch |

There is deliberately no send, archive, label-changing, generic HTTP, approve,
enroll, calendar creation/deletion, or ACL-management MCP tool.

## Cross-account mail search

```json
{
  "accountIds": ["ACCOUNT_ONE", "ACCOUNT_TWO"],
  "query": "subject:receipt newer_than:30d",
  "pageSize": 25,
  "maxPages": 1
}
```

Pass returned continuations back with the same account/query context. Results
retain their account identity. A partial failure is not an exhaustive search.
Message and thread IDs must be routed with the account that returned them.

## Create an unsent draft

```json
{
  "accountId": "ACCOUNT_ONE",
  "requestId": "draft-example-001",
  "to": [{"email": "recipient@example.com", "name": "Recipient"}],
  "cc": [],
  "bcc": [{"email": "copy@example.com"}],
  "subject": "Meeting notes",
  "text": "Here are the notes for review."
}
```

Recipients are structured objects, not raw header strings. From is the verified
account address. For a reply, provide `replyToMessageId` from that same account.
The connector derives and validates the thread, RFC Message-ID references and
matching subject. You still provide recipients explicitly; it does not guess
reply-all. Draft creation never sends.

Unicode bodies, subjects and display names and IDNA domains are supported.
SMTPUTF8/non-ASCII mailbox local parts and arbitrary send-as aliases are not.
File and raw `.eml` attachments remain opaque; retrieval returns bounded bytes
without executing or extracting them.

## Common availability

```json
{
  "calendars": [
    {"accountId": "ACCOUNT_ONE", "calendarId": "primary"},
    {"accountId": "ACCOUNT_TWO", "calendarId": "primary"}
  ],
  "timeMin": "2026-10-05T09:00:00-07:00",
  "timeMax": "2026-10-05T17:00:00-07:00",
  "durationMinutes": 45,
  "maxResults": 5
}
```

Free/busy errors or inaccessible required calendars mean unknown availability,
not "free." Common-free results must not omit failed sources. Time windows are
bounded; Google free/busy requests are batched to respect its calendar limit.

## Private event creation

```json
{
  "accountId": "ACCOUNT_ONE",
  "calendarId": "primary",
  "requestId": "private-example-001",
  "sendUpdates": "none",
  "event": {
    "summary": "Focus block",
    "eventType": "default",
    "visibility": "private",
    "timing": {
      "type": "timed",
      "start": "2026-10-05T10:00:00-07:00",
      "end": "2026-10-05T11:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "attendees": []
  }
}
```

This can take the unconfirmed private path only if the server proves the primary
calendar belongs to the selected account and the operation satisfies all private
constraints. A new private, guest-free recurring series can also use this path,
but its later series/occurrence edits require approval. Default events are not
special focus-time/out-of-office events that
automatically decline invitations.

All-day timing instead uses:

```json
{"type": "allDay", "startDate": "2026-10-05", "endDate": "2026-10-06"}
```

The end date is exclusive. Timed dates require explicit UTC offsets consistent
with the IANA zone, including DST.

## Invitations and recurrence

Create ordinary meeting events with explicit attendee objects and
`sendUpdates: "all"` or `"externalOnly"` as appropriate. A recurring meeting can
add `"recurrence": ["RRULE:FREQ=WEEKLY;COUNT=4"]` to the event. Attendees are not
silently marked accepted.

Updates identify the exact `eventId`, with `scope` equal to `"single"`,
`"series"` or `"occurrence"`. An occurrence ID comes from Google's instance
results; do not manufacture it from a date. The server rejects a scope mismatch
instead of changing a whole series accidentally.

Example attendee addition in `changes`:

```json
{
  "attendees": {
    "mode": "add",
    "attendees": [{"email": "guest@example.com", "optional": true}]
  }
}
```

`mode: "remove"` takes `emails`; `mode: "replace"` takes the intended full
`attendees` list. Incomplete or hidden participant lists cannot be blindly
replaced. Self-RSVP is limited to the authenticated user's proven own calendar
copy. A shared calendar's `self` flag is not permission to RSVP for someone else.

Attendee-affecting changes, every deletion, RSVP and recurring edits return a
pending operation for manual WebAuthn review. A bounded/uncertain recurrence or
recipient preview may be rejected rather than presenting misleading exactness.
An ETag conflict requires reading and reviewing again; consent is not silently
rebased onto new state.

## Operation results

`requestId` is chosen by the caller and must be 8-128 characters using ASCII
letters, digits, `.`, `_`, `:` or `-`. Reusing it for different normalized
arguments is an error.

- `pending_approval`: no write yet; open the returned review URL manually.
- `succeeded`: Google reported success. A later/restarted process may return a
  minimal receipt rather than original event content (`receiptOnly: true`).
- `failed`: preparation or a definitive rejection failed; inspect its error.
- `outcome_unknown`: dispatch may have taken effect. Inspect Google before any
  new write; a new request ID is not an automatic retry workaround.
- `cancelled` / `expired`: the unexecuted proposal cannot be approved.
- `dispatching`: the request is in flight; cancellation cannot guarantee rollback.

Use `operation_status` for the same account and returned operation ID. No
operation tool accepts a human-confirmation boolean or grants approval itself.
