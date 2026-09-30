# Local CLI video demo kit

Reusable text-only snapshot of the rehearsed Ghostty + Copilot CLI + ffmpeg kit.
See the [runbook and current checkpoint](../calendar-verification-video.md) first.
The September 30, 2026 timestamps in `steps.txt` are historical examples, not
authorization to create an event on another date.

The archive contains no account enrollment, signed-in Copilot profile, OAuth
client secret, token, passkey, recording, review image or session log. It does
not contain or install the pending IMAP connector implementation.

## Create a private local runtime

Requirements: macOS, Ghostty, ffmpeg/ffprobe with libx264, Python 3, Node.js 22+,
and a standalone Copilot CLI installed under `~/.copilot-cli/`. The earlier
rehearsal used Copilot 1.0.88 and Ghostty 1.3.1. Later versions must be rechecked.

The locally installed connector is expected at
`~/.local/share/copilot-google-connector/node_modules/`. Do not rebuild or
reinstall it from an older repository revision just to prepare a video.

From the repository root:

```sh
bash docs/video-demo-kit/init.sh
cd "$HOME/.local/share/copilot-google-connector-video-demo"
```

Initialization copies only the six reusable kit files into a new private
directory, creates clean MCP/Copilot configuration, and does not log in, launch
a window, capture a display or call Google. It refuses an existing destination
rather than overwriting a previous take. You can specify a new absolute destination:

```sh
bash docs/video-demo-kit/init.sh /absolute/path/outside/the/repository
```

Do not run the recording kit directly in the repository. Profiles, transcripts,
recordings and review frames must remain local and outside version control.
The original session-local runtime is unaffected by initialization.

## Configure the local copy

Before using `preflight` or `next`, edit the **local runtime**, not committed files:

- In `demo.sh`, replace `YOUR_DEMO_ACCOUNT_ID` with the existing connector account ID
  and `YOUR_DESKTOP_CLIENT_ID` with the public client ID used in the real flow.
- In `steps.txt`, replace every `YOUR_DEMO_ACCOUNT_ID` with the same ID.
- Refresh `PLAN_EVENT_UTC` in `demo.sh` and **all** timestamps and request IDs in
  `steps.txt` together, using a newly approved future plan. The event lasts
  20 minutes; the move is 15 minutes; the availability window is one hour.
  Leave `-video-demo` at the end of request IDs so `DEMO_TAKE` can suffix them.
- Use only the explicitly selected demo account. Never copy credentials or your
  normal profile into this kit.

Authenticate Copilot outside any recording if the clean profile needs it:

```sh
COPILOT_BIN="$(ls -d "$HOME"/.copilot-cli/*/copilot | sort -V | tail -1)"
COPILOT_HOME="$PWD/home" "$COPILOT_BIN" --no-auto-update login
```

Follow the real login yourself. Never paste a token into repository files,
prompts or command arguments. Keep this runtime private even if the CLI stores
fallback authentication data in its configuration.

The generated profile dismisses the desktop-install nudge, trusts only the
runtime's empty `work/` directory, disables incidental notifications, and
registers only `google-local`. The `bin/copilot` wrapper additionally disables
built-in/remote MCPs and limits tools to the recording sequence. Its default model
is `claude-sonnet-4.6`; set `DEMO_MODEL` in `bin/copilot` in the local copy if a
different available public model is required.

No authenticator enrollment or Google account change is performed by these
setup scripts. Retain existing enrollment and perform consent/approval manually.

## Two-window workflow

| Window | Purpose |
|---|---|
| Control | Normal Ghostty on the unrecorded display. Run every `./demo.sh` command here. |
| Stage | Clean full-screen Ghostty on the recorded display. Paste only the demo commands/Copilot prompts here. |

```sh
./demo.sh help
./demo.sh preflight
./demo.sh screen N
./demo.sh stage
./demo.sh capture-test
```

Do not run `preflight` on camera: its filtered account output and setup checks
belong in the control terminal. Run capture/permission checks from your own
Ghostty, not an agent shell whose macOS permissions may belong to another app.

The default font is 28 pt. Clear the stage with Cmd+K before filming. Full screen
is Ctrl+Cmd+F; the browser belongs in another full-screen Space on the same display.

## Controls

```sh
./demo.sh list              # Step labels, no clipboard change
./demo.sh show N            # Show one prompt, no clipboard change
./demo.sh next              # Copy next prompt; operator pastes it in the stage
./demo.sh record start      # Real display capture; operator runs this deliberately
./demo.sh record stop
./demo.sh finalize
./demo.sh review
./demo.sh frame SECONDS
./demo.sh status
```

`next`, `clip`, `again` and `back` write the operator's clipboard. They are not
commands for an agent to execute automatically. Write-step copying requires
configured identifiers, a running recording and an event at least an hour ahead.
Tool-level human approval still applies regardless of these script checks.

Output is private in `out/`; `home/` contains the local profile and transcripts.
None should be uploaded without deliberate privacy review.

`DEMO_READONLY=1` and `DEMO_DENY_WRITES=1` are wrapper-only rehearsal controls.
They can be used when invoking `bin/copilot` directly; the clean stage-shell
environment does not inherit them from the control terminal. Never perform
extra real writes just to test a rehearsal.

`DEMO_SYNTH=1` substitutes a generated video source for **encoding tests only**.
A synthetic test is not a real application demo or evidence of screen permission.
