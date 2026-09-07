# Security and approval model

## What the connector protects

The supported interface rejects accidental or prompt-injected risky tool calls
unless an enrolled authenticator completes an exact-operation approval.
OAuth credentials are protected at rest by the selected OS vault. Tokens are
never returned through tools, logged, put into command arguments, or stored in
source/plaintext configuration. Short-lived tokens stay in process memory.

This is **not an operating-system sandbox**. A malicious process running as your
user may be able to replace this connector, alter enrollment or state, read an
unlocked vault, or control a browser. Do not grant untrusted code unrestricted
access to the credential-bearing user account and then assume an MCP permission
prompt isolates it. Trust the installed executable and its dependencies.

Google messages, events and attachment contents remain untrusted data. They are
rendered as inert text, never executed or used as instructions. HTML/image
resources are not loaded remotely. No connector telemetry or content cache is
intended. Tool results still reach Copilot and its configured model/provider.

## Human approval is separate from tool permission

MCP annotations, saved tool approvals, allow-all/autopilot settings and a
client-supplied `confirm` flag do not prove a human reviewed an action. The
connector therefore does not use them as transaction authorization.

Risky Calendar tools prepare an operation and return a review URL. The URL and
operation ID are identifiers, not authorization secrets. Knowing them is not
enough to execute an action.

The loopback page displays a server-owned frozen manifest: account identity,
calendar, event and exact change, current/new/removed attendees, recurrence scope,
and notification behavior. It obtains a WebAuthn assertion from a **previously
enrolled** credential. The server verifies the signature, credential ID, exact
challenge/origin/RP, ceremony type, and signed user-presence and user-verification
flags. A fresh challenge is bound to the operation digest and has a finite
lifetime. Proposal approval is single-use and account/credential-generation bound.

Precisely, this proves an enrolled authenticator produced an UP+UV assertion
bound to the operation displayed by the trusted page. It does **not** prove the
user read every field. A normal passkey prompt authenticates a ceremony, not an
independent display of Calendar details. A shared PIN/authenticator may be usable
by multiple people. A compromised browser or enrollment bootstrap remains unsafe.

The service binds only to loopback, checks exact Host/Origin, prevents framing,
uses restrictive content policy and no third-party scripts, and does not embed
Google tokens in review pages or URLs. A fake confirmation POST or a virtual
credential not already enrolled cannot authorize an operation.

## Enrollment and trusted recovery

Run `approvals enroll` **yourself**, in a trusted terminal and browser, before
using risky writes. Initial enrollment is a trust bootstrap, not proven human
merely because it started from a CLI. Do not let an agent enroll its own
credential. Service mode does not expose registration or key replacement.

Use a platform or roaming authenticator that supports user verification. A
touch-only key without UV is insufficient. A Linux secret service is not a
WebAuthn authenticator.

For a lost authenticator, there is deliberately no agent-callable reset:

1. Stop all running connector MCP/CLI processes.
2. Locate the connector's own state directory using `doctor`.
3. Inspect `approval-enrollment.json` in that directory; remove only that record
   through trusted local maintenance, never the whole state directory or
   operation receipts.
4. Run `approvals enroll` again yourself.
5. Restart MCP and submit fresh operations. Old review pages and prepared work
   must not be reused.

Do not reinterpret corrupt/unreadable enrollment state as first-time setup.
Public keys are not secret, but their integrity is security-critical.

Open review URLs in your trusted browser. If a cross-origin navigation is
rejected, paste the URL into its address bar directly; do not weaken the
Host/Origin policy or embed the page in a frame.

## Safe private changes

Every deletion (including cancellation semantics), RSVP, recurring edit, and
attendee-affecting change requires approval. `sendUpdates: "none"` alone never
removes this requirement.

Only ordinary default-event, private, no-guest creates on the account's own
primary calendar may bypass the extra approval with explicit `none` notifications.
This includes a new private recurring series, which has no existing exceptions.
Such a series receives no private-edit provenance; subsequent recurring edits
still require approval.
Private edits additionally need connector-created private provenance and ETag
continuity, no recurrence, and no attendees before or after. Unknown/shared
effects or externally changed events require a new review. Special event types
that can automatically decline invitations are not part of this exception.

## Dispatch, cancellation and recovery

Write request IDs bind normalized arguments; reusing one for different content
is an error. Preparation and approval are not execution. A durable dispatch
marker is written before network transmission. Approval denial, expiry and
cancellation can prevent a write **before** dispatch; they cannot recall a
request already sent to Google.

No non-idempotent write is blindly retried. Lost responses, interrupted dispatches
and ambiguous Google errors produce an unknown outcome. Calendar creations have
stable request-bound IDs for reconciliation. Gmail draft creation does not have
the same provider-side idempotency guarantee; inspect Gmail before starting a
new request. Do not delete operation receipts to make a retry "work."

Account generation and a lifecycle barrier stop new stale-token dispatches after
removal/reauth. Requests that already dispatched may complete. Event ETags
protect the mutated resource; they cannot atomically lock a recurring master and
every exception. The connector must not silently rebase a reviewed operation or
pretend a partial participant list is complete.

Locks are not stolen from live processes. After a crash, stop all connector
processes before removing only a positively identified orphaned lock. State files
are atomically replaced and flushed where the platform supports it; no
application-level journal is a guarantee against arbitrary hardware corruption.

## Validation boundaries

Synthetic transports, fake vaults and virtual authenticators are for isolated
tests only. They demonstrate local protocol/state behavior, not Google
connectivity, real human presence, native cross-platform execution, or actual
invitation delivery. No production CLI/environment switch bypasses approval or
redirects credentialed Google requests to a test server.

Live acceptance requires a user-provided account and explicit permission. OAuth,
vault unlock prompts, approval enrollment and app-configuration installation must
not happen silently as part of validation.
