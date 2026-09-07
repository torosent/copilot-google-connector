# Google and platform setup

## Bring your own Desktop OAuth client

1. Create or select a project in Google Cloud Console.
2. Enable the **Gmail API** and **Google Calendar API**.
3. Configure Google Auth Platform branding, audience, consent and test users.
   Organization policies may restrict which applications a Workspace account can
   authorize. An Internal audience applies only to eligible organization users.
4. Create an OAuth client with application type **Desktop app**. Do not substitute
   a Web, service-account, device-code or domain-wide-delegation credential.
5. Download the client JSON into a private location outside this project. Import
   it with `google-connector auth client import --file PATH`.
6. Run `accounts add` deliberately. The browser selects a Google account; grant
   only the capabilities you want. Repeat for each distinct account.
7. Save the opaque account IDs returned by `accounts list`. An email is display
   metadata, not a default account-routing rule.

The connector uses browser OAuth with a random-port loopback callback, PKCE S256,
random state and nonce, verified Google identity, and offline refresh. No password
is collected by the connector. Refresh tokens and client secrets live in the OS
vault. Reauth must return the same Google subject as the account being refreshed.

## Requested scopes

| Scope | Why |
|---|---|
| `openid email` | Verify the Google subject and email |
| `gmail.readonly` | Search and read messages, threads and attachments |
| `gmail.compose` | Create drafts; Google also grants sending at scope level |
| `calendar.events` | Read and change events |
| `calendar.calendarlist.readonly` | Discover accessible calendars |
| `calendar.events.freebusy` | Query availability on accessible calendars |

The non-identity scopes use the `https://www.googleapis.com/auth/` prefix.
There is no full Gmail, Gmail modify, blanket Calendar, calendar creation or ACL
scope request. `calendar.events` does not by itself authorize `freeBusy.query`.

Both requested Gmail scopes are **restricted**. Google has no draft-only scope:
removing send tools does not reduce the consent grant to draft-only access.
Keep that limitation in mind before authorizing the client.

BYO clients are useful for reusable local tools, but they do not universally
exempt an app from Google's verification and user-data policies. Shared/public
client distribution would need its own ownership, consent branding and applicable
verification review. This project does not provide a shared client or claim
verification approval. Remote handling of restricted data can affect applicable
assessment requirements; consider the Copilot host's data flow too.

An External consent project in **Testing** normally issues refresh tokens that
expire in **seven days** for these Gmail/Calendar scopes. Repeatedly obtaining
new grants can also hit Google's per-account/client token limits and invalidate
older tokens. Account policy changes and revocation can require reauth.

## Credential storage

- **macOS:** native Keychain access. Unlock your login keychain and approve any OS
  access prompt only for the trusted executable.
- **Windows:** native Credential Manager. Use your own desktop user profile.
  Vault-item sizes are checked; there is no plaintext fallback.
- **Linux desktop:** install the distribution's `libsecret-tools` package
  (package names may vary), ensure `secret-tool` is on PATH, and run in a desktop
  session with an available Secret Service such as GNOME Keyring. A missing,
  locked or inaccessible service is an error, not an empty credential store.
  Secrets are passed through a private pipe, not command arguments.

The generic keyring package's Linux fallback to kernel keyutils is deliberately
not used. Linux Secret Service availability is separate from browser/passkey
availability.

## Readiness and troubleshooting

`google-connector doctor` reports local metadata and checks it has not performed.
It does not initiate OAuth or prove that a token, vault or API works.

| Problem | Action |
|---|---|
| No client imported | Import your Desktop client JSON |
| Consent denied or scopes missing | Deliberately reauth and choose the needed grants |
| Account mismatch during reauth | Sign in to the original identity, or add a separate account |
| `invalid_grant` / expired Testing token | Reauthorize the explicitly selected account |
| API disabled or Workspace policy denial | Review the Google Cloud/Workspace settings |
| `vault_unavailable` on macOS with version 0.1.0 | Upgrade to 0.1.1 and retry. A connector bug rejected the native library's byte-array result; do not reset Keychain or delete your credentials for this error |
| Vault unavailable or locked | Restore the OS service; never enable plaintext storage |
| Pending approval | Open the review page manually and use the enrolled authenticator |
| ETag/precondition conflict | Read the changed event and submit a newly reviewed request |
| Unknown write outcome | Inspect Google first; never blindly create another event or draft |
| Orphaned local lock | Stop every connector process before removing only the reported lock directory |

Account removal is local and explicit. It invalidates pending work and prevents
new requests after the account is removed; a request already sent to Google may
still complete. For provider-side revocation use Google Account Permissions.

## References

- [Google native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [OAuth token limits and expiry](https://developers.google.com/identity/protocols/oauth2)
- [Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Copilot desktop customization](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)
