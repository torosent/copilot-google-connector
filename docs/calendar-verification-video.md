# Calendar verification video: runbook and resume checkpoint

**Paused on September 30, 2026. No verification video exists yet.** Capture
tests and an unrecorded consent dry-run succeeded. Nothing has been uploaded to
YouTube or submitted for Google verification, and no demo event has been created,
updated or deleted.

This handoff preserves the CLI recording workflow and its current state.
It does not publish the local connector's pending IMAP implementation or a new
desktop release. Google verification is not yet approved.

## Current checkpoint

| Item | Status |
|---|---|
| Recording approach | Ghostty stage window, standalone Copilot CLI, installed `google-local` MCP connector, ffmpeg |
| Capture permission | Verified from the operator's Ghostty, not the agent's shell |
| Recording display | Screen 1, DELL P2723QE; screen 0 is the unrecorded ultrawide control display |
| Capture quality | 5120x2880 input, 2560x1440 H.264 output, 30 fps |
| Latest test | 240 frames in 8.02 seconds; encoder speed 0.997x real time |
| Terminal | Full-screen clean stage window; font enlarged to 28 pt; frames readable and free of private information |
| Browser | Operator reports demo-only Edge Beta profile ready on the recorded display |
| Consent dry-run | Operator reports successful Calendar/identity reauthentication on September 29 |
| Earlier Google block | Did not recur in the dry-run; historical cause remains unknown |
| Passkey approval | Existing enrollment retained; availability in the demo browser remains untested |
| Actual recording | Not started; kit was at step 0 of 12, with no recording session |
| Event mutations | Write requests rehearsed with tools denied; no demo event created |
| Scope/client review | Final Google Data Access list and all clients still need reconciliation |

Chatter's built-in IMAP migration was merged as
[torosent/chatter#128](https://github.com/torosent/chatter/pull/128), revision
`cdc91657047d9f153bac5a599c7608c4848d244b`, with hosted and sync deployments
verified. The homepage/privacy update was merged as
[torosent/terminal#10](https://github.com/torosent/terminal/pull/10), revision
`922634c3178d8011ba9af85b55329dc3cacb1180`, and production pages were verified.
These are prior checkpoints, not new deployment checks or claims about all
desktop/self-hosted installations.

## Start here when resuming

1. Prepare a local runtime using the [demo kit instructions](video-demo-kit/README.md).
   The original session-local kit remains intact; the repository copy intentionally
   excludes its signed-in profile, account identifiers, recordings and logs.
2. **Refresh and explicitly approve the event plan before recording later.**
   The archived prompts use September 30, 2026, 17:00-18:00 UTC. They are not a
   rolling schedule. Replace all event/window timestamps and request IDs together,
   then recheck the selected demo calendar using read-only tools.
3. Resolve the browser-toolbar question below. It is the immediate unfinished
   step from the consent dry-run.
4. Recheck the isolated browser profile, display mapping, capture permission,
   tool versions, passkey availability and final scope/client list. Yesterday's
   checks are not proof that a later setup is still correct.

The earlier approved disposable event was **Chatter verification demo**, private,
on the demo account's own `primary` calendar, with no guests or recurrence and
`sendUpdates: none`. Its original time was September 30, 10:00-10:20 AM Pacific
(17:00-17:20 UTC), moved to 10:15-10:35 AM Pacific (17:15-17:35 UTC), then deleted
through manual passkey approval. The operator also approved its inherited
30-minute popup reminder.

That authorization does not extend to arbitrary future dates or rehearsal writes.
The archived kit refuses write-step copying when the event is less than an hour
away or already past. Do not change the system clock or bypass that check.

## Browser privacy gate

The installed connector's successful loopback callback leaves a short-lived
authorization code in the browser's URL. **Do not capture or upload that URL.**

Before filming, establish that full-screen Edge Beta can hide its toolbar when
the pointer is in the page, and that redirects will not reveal it again.
On the real Google consent screen, show the app name, full OAuth `client_id` and
requested scopes. Hide the toolbar before the final Allow/Continue action and
keep it hidden until the callback tab has been closed.

This behavior has **not** been confirmed yet. If the callback URL cannot reliably
be kept off camera, stop and establish another safe capture arrangement. Do not
assume that a normal full-screen window hides its address bar.

Stop recording before any password, app password, recovery code, passkey-provider
account selector or OS authentication prompt. Resume only after the sensitive
screen is gone. Consent and authenticator approval must be performed by the
operator, never automated.

## Scope coverage and draft justifications

These are drafts to reconcile with the actual implementation and Google's
current Data Access list, not assertions that the review has been approved.

| Scope | Actual functionality and why narrower access is insufficient |
|---|---|
| `calendar.events` | Read/search/create/update/delete events and RSVP on accessible calendars. Read-only access cannot make those changes; owned-only access would not cover editable calendars the user does not own. Full calendar administration is not requested. |
| `calendar.calendarlist.readonly` | Discover subscribed calendars so the user can explicitly select a calendar. No calendar metadata changes. |
| `calendar.events.freebusy` | Query busy intervals and find common availability across selected calendars/accounts. The events scope does not authorize `freeBusy.query`; this scope does not return event details. |
| `openid`, `email` | Verify identity and route each request to an explicitly selected account. |
| `calendar.events.readonly` (Chatter built-in) | Search/list primary-calendar events without mutation. This separate grant is not requested by the local connector. |

The local connector requests the first four rows, **not** the separate read-only
grant. Reading an event with read/write access does not demonstrate read-only
consent. If the shared Cloud project review still includes Chatter's read-only
scope or another OAuth client, supply that client's actual relevant flow as
required. A local Desktop-client demo does not automatically cover a distinct
hosted Web client.

Do not remove scopes that remain in use just to match the video, mock consent,
or claim the CLI covers a hosted client it never shows. Additional coverage is a
submission gate, not authorization to visit or record the hosted Chatter app.
The primary video shows only the local connector, plus public informational pages.

Risky Calendar writes, including deletions, RSVP, attendee-affecting changes and
recurring edits, require explicit local passkey approval. A private no-guest
create on the user's own primary calendar can execute without that approval;
private edits additionally require connector-established provenance and unchanged
ETags. Deletion always requires approval.

## Unrecorded preparation

- Use a demo-only Google account and primary calendar with no private appointments
  in the selected window. Do not delete real data to prepare a demo.
- Use a separate profile in the default browser; the connector opens that browser.
  Sign in only as the demo account. An Edge/Microsoft sync login is not needed.
- Put the browser in its own full-screen Space on the recorded display, wide
  enough to show the complete client ID on the consent screen.
- Leave existing approval enrollment unchanged. Confirm the enrolled passkey is
  available to the browser used for approval; never automate enrollment.
- Turn on Do Not Disturb and close chat/mail applications. Keep personal windows
  on the unrecorded display.
- Check Google branding, Search Console ownership, Audience/test-user restrictions,
  requested scopes and client IDs. The recorded client must match the submitted
  review. Do not change clients to evade a Google block.

From the **unrecorded control Ghostty**, in the local runtime directory:

```sh
./demo.sh preflight
./demo.sh screen 1   # Recheck display mapping first; 1 was the earlier choice.
./demo.sh stage
```

Drag the stage window onto the selected display, then press **Ctrl+Cmd+F**.
The cyan `$` prompt identifies the stage. Clear it with **Cmd+K** before filming.
The stage is only for commands/prompts shown in the video; `./demo.sh` controls
belong in the other terminal.

```sh
./demo.sh capture-test
```

This records an eight-second test and retains two review frames plus an encoder
log, not a verification video. Inspect both frames. A wallpaper-only frame on an
empty display does not prove permission is missing; preflight checks the permission
for the terminal app actually running the script. Ghostty permission does not
imply the agent's shell has permission.

If another consent dry-run is needed, run it unrecorded:

```sh
node "$HOME/.local/share/copilot-google-connector/node_modules/copilot-google-connector/dist/cli.js" \
  accounts reauth YOUR_DEMO_ACCOUNT_ID
```

Choose only the demo account and verify Chatter plus identity/Calendar access,
without Gmail OAuth scopes. The loopback flow times out after about three minutes.
If Google blocks access, stop and diagnose the exact restriction.

## Record the real flow

Run all controls in the **unrecorded control terminal**:

```sh
./demo.sh reset
./demo.sh record start
```

After the five-second countdown, show the browser's public homepage
<https://tomer.dev/chatter> and privacy link
<https://tomer.dev/chatter/privacy>. Then use `./demo.sh next` to copy each
step, paste into the stage with **Cmd+V**, and press Return only at a normal
shell/Copilot prompt. Wait for each result before advancing.

| Step | What to show |
|---|---|
| 1-2 | Caption, connector reauthentication, real English Google consent, Chatter name, full client ID and scope list |
| 3-4 | Caption and standalone Copilot startup in the isolated profile |
| 5 | `calendar_list_calendars` for only the demo account |
| 6 | Create the approved private, no-guest disposable event |
| 7 | Read back the exact returned event ID |
| 8 | Move that same event 15 minutes later |
| 9 | Show free/busy for the approved one-hour window |
| 10 | Find availability: 20 minutes, at most 3 results |
| 11 | Request deletion, show pending approval, operator reviews the exact event and manually approves |
| 12 | Check `operation_status`; confirm deletion actually succeeded |

For the original plan, busy time after moving should be 17:15-17:35 UTC and the
available interval should be 17:35-18:00 UTC. Refresh these expectations if the
approved window changes.

Never run `accounts list` or `doctor` on camera: they expose other accounts.
If Copilot displays **"Install it now?"**, press **N**, never Return.
The wrapper limits tools to this demo; do not replace it with a personal
`copilot` alias or a profile containing other MCP servers.

If update unexpectedly returns `pending_approval`, handle it manually before
continuing. If any write returns `outcome_unknown`, stop and reconcile it rather
than blindly retrying. Keep the event ID returned by the create; never guess it.
An approval URL or pending result is not proof of deletion.

## Stop, review and resume a take

```sh
./demo.sh record stop
./demo.sh finalize
./demo.sh review
```

The final MP4 and review frames stay in the local runtime's `out/` directory.
Watch the **entire video** locally: sampled frames alone cannot prove that brief
credentials, callback codes, account selectors or notifications never appeared.
Check legibility, real consent coverage, all requested scopes and actual cleanup.
The kit captures video without audio; its captions/prompts are in English.

For a sensitive prompt, `record stop` pauses capture and another `record start`
adds a part. `finalize` joins parts in order. Do not hide an unperformed operation
or replace real consent with a mock.

If abandoning a take after create, reconcile and remove only the disposable event,
with the operator's explicit cleanup approval. Account for any pending operation.
For a retake, after confirming cleanup:

```sh
export DEMO_TAKE=2
./demo.sh record new
./demo.sh reset
```

Keep `DEMO_TAKE` set for all controls in that take so request IDs are consistently
different. Do not reuse an idempotency key for changed event details.

## Completion and submission gate

- [x] Capture permission, full-screen stage and enlarged text verified.
- [x] Real capture kept up at 30 fps.
- [x] Operator reported successful unrecorded real consent.
- [ ] Refresh and approve the future event plan; recheck the demo calendar.
- [ ] Confirm browser-toolbar behavior prevents callback-code exposure.
- [ ] Confirm enrolled-passkey availability in the approval browser.
- [ ] Reconcile final Data Access scopes, all clients, branding and ownership.
- [ ] Record and review the whole video for private data and scope coverage.
- [ ] Confirm disposable-event deletion with no unresolved write outcome.
- [ ] Operator approves upload as **YouTube Unlisted**, not public.
- [ ] Operator approves Verification Center submission with the real video URL.

Uploading a video and submitting a review are separate actions. Neither recording
nor this handoff authorizes them automatically. A saved video, working OAuth flow
or valid branding does not prove Google has approved sensitive-scope access.

Reference:
<https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification>
