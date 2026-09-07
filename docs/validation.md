# Validation and acceptance boundaries

## Repeatable offline checks

```sh
npm test
npm run smoke:package
```

The suite uses synthetic messages/events, injected transports/vaults, private
temporary state directories and loopback test listeners. It must never mutate
live Google data, read a user's vault, launch real OAuth, or enroll a user's
authenticator as a side effect.

Coverage includes:

- PKCE/state/nonce callback validation and cleanup; real signature verification
  of synthetic Google-style identity tokens.
- Scope and account/generation isolation, reauth/removal races, refresh
  coordination, platform-adapter failures and credential secrecy.
- Gmail MIME/Unicode/Bcc, exact reply subject and RFC headers, bounded external
  body retrieval, attachment membership, thread limits and pagination.
- Calendar timezone/DST/all-day rules, recurrence target identity, attendee and
  self-RSVP semantics, unknown availability, explicit notifications and ETags.
- WebAuthn signature/UP/UV/origin/challenge validation with **synthetic keys**,
  enrollment bootstrap isolation, cancellation, expiry, concurrent replay and
  invalidated account/credential generations.
- Durable request deduplication, dispatch receipts, known versus unknown results,
  persistence errors and the limit of cancellation after dispatch.
- Production-server stdio initialize/discovery/readiness without credentials.
- Browser-script syntax and binary WebAuthn serialization in a **fake browser**.
- Tarball allowlist and installation with production dependencies only outside
  the source tree, followed by installed CLI/stdio checks.

Synthetic cryptographic assertions are useful because they exercise the actual
verifier. They are not proof of real human presence or physical authenticator
compatibility. Likewise, injected Windows/Linux adapters do not establish native
runtime behavior on those operating systems.

## Opt-in live acceptance

These steps require the operator's own credentials, an appropriate test account,
and explicit consent. They have **not** been performed by the offline suite:

| Area | Operator acceptance check |
|---|---|
| Native vault | Confirm the OS-specific adapter can store/read/delete a disposable item and rejects a locked or unavailable service |
| OAuth | Import the intended Desktop client, authorize two distinct accounts and verify their displayed identities |
| Reauth | Reauthorize one account and confirm the other account remains independent |
| Copilot desktop | Deliberately install the printed MCP configuration and confirm discovery in the intended scope |
| Gmail | Read known synthetic test mail and inspect a created draft in Gmail; never send it as an automatic check |
| Private Calendar | Create/read/edit a disposable private, non-guest event on the selected account |
| Approval | Enroll the intended real authenticator yourself; inspect exact data before approving a test operation |
| Denial | Decline/cancel an operation and confirm it did not mutate Calendar |
| Invitations/RSVP | Only with explicitly consenting test participants, confirm notifications and RSVP behavior |
| Recurrence | Check ordinary whole-series and moved single-occurrence handling, and the refusal of unsafe exception-bearing series edits |
| Removal | Remove one account locally and confirm no new requests can dispatch under it |

Do not use real mail/event content as committed fixtures. Do not turn a local
test failure into live writes, broader scopes, plaintext token storage, a
permission bypass, or a new request ID after an unknown outcome.

Actual delivery of notifications remains controlled by Google and recipient
settings. An ETag protects its target event, not an atomic snapshot of every
resource in a recurring series.
