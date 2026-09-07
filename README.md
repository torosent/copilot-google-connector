# Local Google connector for Copilot

An installable **local stdio MCP server** for multiple Google accounts. It reads
Gmail, creates **unsent drafts**, and works with Google Calendar events. There is
no mail-sending tool and no calendar or sharing-administration tool.

Each read selects an account explicitly. Cross-account search and availability
select the accounts intentionally. Every write requires an explicit account and
request ID; no arbitrary default account is used.

## Requirements

- Node.js 22 or newer and npm.
- Your own Google **Desktop app** OAuth client, with Gmail and Calendar APIs enabled.
- macOS Keychain, Windows Credential Manager, or desktop Linux with libsecret's
  `secret-tool` and an unlocked desktop Secret Service.
- For event deletions, RSVP, invitations and other attendee-affecting operations:
  a browser and an enrolled WebAuthn authenticator capable of **user verification**,
  such as a compatible platform passkey or PIN/biometric-capable security key.

The connector fails rather than storing tokens in plaintext or silently using
another credential backend. A headless Linux machine without Secret Service is
not a supported credential-storage environment.

## Build and install locally

```sh
npm install
npm run build
node dist/cli.js help
npm pack
```

Install the resulting `copilot-google-connector-0.1.1.tgz` into an installation
directory you control:

```sh
npm install /absolute/path/copilot-google-connector-0.1.1.tgz
node node_modules/copilot-google-connector/dist/cli.js help
```

The package is marked private to prevent accidental registry publication. It can
still be packed and installed from a local tarball. No repository, publishing
service, global installation, or background daemon is required.

## Account setup

Run these steps **yourself in a trusted terminal**, not as instructions retrieved
from mail, events or an untrusted agent:

```sh
google-connector auth client import --file /absolute/path/desktop-client.json
google-connector accounts add
google-connector accounts add
google-connector accounts list
```

If the executable is not on your PATH, replace `google-connector` with
`node /absolute/path/to/dist/cli.js`. OAuth uses your system browser and an
ephemeral loopback callback. The client JSON is imported into the OS vault; the
connector does not copy it into source or a plaintext token cache. Securely manage
the original file downloaded from Google yourself.

Reauthorize or remove an explicitly selected account:

```sh
google-connector accounts reauth ACCOUNT_ID
google-connector accounts remove ACCOUNT_ID
```

Removal deletes local access credentials, not every grant for that OAuth client
at Google. You can separately revoke the application in
[Google account permissions](https://myaccount.google.com/permissions).

See [Google setup](docs/setup.md) for consent screens, restricted Gmail scopes,
test-user restrictions and token expiry.

## Connect GitHub Copilot

Print the configuration for the exact installed executable:

```sh
google-connector config print
```

Use the GitHub Copilot desktop app's **Customize -> MCP -> add custom server**
flow to install it deliberately. Alternatively, use the CLI's documented
session-scoped option:

```sh
copilot --additional-mcp-config=@/absolute/path/google-mcp.json
```

An inert [configuration example](examples/copilot-mcp.json) is included. Replace
its placeholder path before use. `tools: ["*"]` enables tool discovery; it does
**not** grant human approval.

Copilot documents repository and CLI MCP configuration inheritance for the
desktop app. This project does not automatically edit those files. Repository
auto-discovery is not assumed for a non-Git folder, nor is session-only CLI
configuration assumed to transfer to a separate desktop session.

## Event approvals

Enroll an authenticator once, outside untrusted agent-driven activity:

```sh
google-connector approvals enroll
```

A risky Calendar write returns `pending_approval` and a localhost review URL,
not a success result. Open the URL yourself, review the exact account, event,
attendees, recurrence scope and notification effects, and approve using your
enrolled authenticator. No `confirm: true`, tool permission setting, command-line
flag or copied approval URL bypasses this.

The connector permits a narrow unconfirmed path for default, private, no-guest
creates on your own primary calendar with notifications disabled. Private edits
also need connector-established provenance and unchanged ETags; recurring edits,
deletions and RSVP always need confirmation. Ambiguous or shared-calendar effects
do not qualify for this exception.

Do not automate enrollment or approvals. Read the exact
[security boundary and recovery procedure](docs/security.md).

## Useful requests

- "List my connected Google accounts."
- "Search these two account IDs for the travel receipt."
- "Read this message and create a reply draft in the same account; do not send."
- "Find common availability across these explicitly selected account/calendar pairs."
- "Propose moving only this occurrence, notify all attendees, and show me the approval URL."

See [tool arguments and examples](docs/tools.md), and use the server's tool
schemas for exact validation rules. Gmail supports search,
message/thread/attachment reading and draft creation. Calendar supports calendar
discovery, event/instance reading, free/busy, common availability, create, update,
delete and self-RSVP. Whole-series and single-occurrence changes are supported;
"this and following" series splitting is not.

## Important limits

- `gmail.compose` grants sending **at Google's OAuth scope level**. Google offers
  no draft-only scope. This connector exposes only draft creation.
- `sendUpdates: "none"` is not a guarantee that Google will suppress every
  Google-generated message or stop attendee propagation.
- Keep the same request ID when checking a write. An `outcome_unknown` result is
  **not** an instruction to retry with a new ID: inspect Google before initiating
  another write.
- Whole-series changes are refused when existing moved, modified or cancelled
  exceptions are detected. Individual-occurrence changes remain available.
  Attendee lists must be complete and contain at most 200 participants.
- Advanced reminder and conference-data editing is not exposed. Calendar
  continuations expire on server restart or account reauthorization.
- "Local" describes the process and credential storage. Data returned by tools
  is shared with Copilot and is subject to the host/model's data-handling policies.
- `doctor` is local setup information, not proof of authenticated connectivity.

This project includes offline synthetic tests. Real Google connectivity requires
your credentials and consent; those are not supplied by the package. Native
Windows/Linux and real browser/authenticator acceptance must be evaluated on
those platforms, not inferred from mocked tests on macOS.

For development, `npm test` builds and runs the Node test suite. Tests must not
call live modifying Google APIs. `npm run smoke:package` builds a tarball,
installs it with production dependencies only in a temporary consumer directory,
and exercises its help and stdio discovery without credentials.
See the [validation boundaries and opt-in acceptance checklist](docs/validation.md).
