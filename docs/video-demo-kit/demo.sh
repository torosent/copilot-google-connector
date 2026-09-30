#!/bin/bash
# Chatter local connector - Google OAuth verification demo kit
# (Ghostty stage window + Copilot CLI + ffmpeg screen recording).
#
# Run this from your regular, UNRECORDED "control" terminal:   ./demo.sh help
# Compatible with the macOS system bash (3.2).

KIT="$(cd "$(dirname "$0")" && pwd)"
OUT="${DEMO_OUT:-$KIT/out}"
STEPS="$KIT/steps.txt"
DEMO_ACCOUNT="YOUR_DEMO_ACCOUNT_ID"
EXPECTED_CLIENT_ID="YOUR_DESKTOP_CLIENT_ID"
CONNECTOR_DIR="$HOME/.local/share/copilot-google-connector"
CONNECTOR_BIN="$CONNECTOR_DIR/node_modules/.bin/google-connector"
PLAN_EVENT_UTC="2026-09-30T17:00:00Z"

FFMPEG="${FFMPEG:-$(command -v ffmpeg 2>/dev/null)}"
[ -x "${FFMPEG:-}" ] || FFMPEG=/opt/homebrew/bin/ffmpeg
FFPROBE="${FFPROBE:-$(command -v ffprobe 2>/dev/null)}"
[ -x "${FFPROBE:-}" ] || FFPROBE=/opt/homebrew/bin/ffprobe
PY3="$(command -v /usr/bin/python3 2>/dev/null)"
[ -n "$PY3" ] || PY3="$(command -v python3 2>/dev/null)"

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
case "${1:-help}" in
  help|-h|--help|list|show) ;;
  *) [ -d "$KIT/home" ] || die "Run init.sh first; use the private runtime, not the repository copy." ;;
esac
have() { command -v "$1" >/dev/null 2>&1; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

newest_copilot() {
  if [ -n "${DEMO_COPILOT_BIN:-}" ]; then echo "$DEMO_COPILOT_BIN"; return; fi
  ls -d "$HOME"/.copilot-cli/*/copilot 2>/dev/null | sort -V | tail -1
}

# --------------------------------------------------------------------------- displays

# Prints "ACCESS 0|1|-1" and one "DISPLAY <n> ..." line per active display, in the same order
# that ffmpeg numbers "Capture screen <n>".
display_info() {
  "$PY3" - <<'PY'
import ctypes, ctypes.util, sys
path = ctypes.util.find_library("CoreGraphics")
if not path:
    print("ACCESS -1")
    sys.exit(0)
cg = ctypes.CDLL(path)
u32 = ctypes.c_uint32

class P(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
class S(ctypes.Structure):
    _fields_ = [("w", ctypes.c_double), ("h", ctypes.c_double)]
class R(ctypes.Structure):
    _fields_ = [("o", P), ("s", S)]

cg.CGDisplayBounds.restype = R
cg.CGDisplayBounds.argtypes = [u32]
cg.CGMainDisplayID.restype = u32
cg.CGDisplayIsBuiltin.restype = ctypes.c_int
cg.CGDisplayIsBuiltin.argtypes = [u32]
cg.CGGetActiveDisplayList.restype = ctypes.c_int32
cg.CGGetActiveDisplayList.argtypes = [u32, ctypes.POINTER(u32), ctypes.POINTER(u32)]
try:
    cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
    access = int(bool(cg.CGPreflightScreenCaptureAccess()))
except Exception:
    access = -1
print("ACCESS %d" % access)
ids = (u32 * 16)()
count = u32(0)
cg.CGGetActiveDisplayList(16, ids, ctypes.byref(count))
main = cg.CGMainDisplayID()
for i in range(count.value):
    d = ids[i]
    b = cg.CGDisplayBounds(d)
    print("DISPLAY %d id=%d main=%d x=%d y=%d w=%d h=%d builtin=%d" % (
        i, d, int(d == main), b.o.x, b.o.y, b.s.w, b.s.h, cg.CGDisplayIsBuiltin(d)))
PY
}

# Prints "<avfoundation video index> <capture screen number>" per line.
capture_devices() {
  "$FFMPEG" -hide_banner -nostdin -f avfoundation -list_devices true -i "" 2>&1 \
    | sed -n 's/.*\[\([0-9][0-9]*\)\] Capture screen \([0-9][0-9]*\).*/\1 \2/p'
}

# One definitive line about Screen Recording for the app running this terminal.
# $1 = what a wallpaper-only frame means when permission IS granted.
screen_access_note() {
  case "$(display_info 2>/dev/null | sed -n 's/^ACCESS //p')" in
    1)  echo "Screen Recording: granted to this terminal app. $1" ;;
    0)  yellow "Screen Recording is NOT granted to this terminal app, so frames show only the wallpaper. Enable it in System Settings > Privacy & Security, then quit and reopen this app." ;;
    *)  echo "Screen Recording: could not be determined. If a display that has windows on it shows only the wallpaper, permission is missing." ;;
  esac
}

display_names() {
  system_profiler SPDisplaysDataType 2>/dev/null | awk '
    /^ +Displays:/ { on = 1; next }
    on && /^        [^ ].*:$/ { name = $0; sub(/^ +/, "", name); sub(/:$/, "", name); next }
    on && /Resolution:/ { r = $0; sub(/^ +Resolution: /, "", r); print name ": " r }
  '
}

file_size() { stat -f%z "$1" 2>/dev/null || echo 0; }

duration_of() {
  "$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null | awk '{ printf "%.1f", $1 }'
}

# --------------------------------------------------------------------------- steps

step_count() { grep -c '^## ' "$STEPS"; }

step_get() { # step_get N kind|label|text
  awk -F'[|]' -v n="$1" -v want="$2" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^## / {
      num = $1; sub(/^## /, "", num); num = trim(num)
      cur = (num == n)
      if (cur) { kind = trim($2); label = trim($3) }
      next
    }
    cur && NF { text = (text == "" ? $0 : text " " $0) }
    END { if (want == "kind") print kind; else if (want == "label") print label; else print text }
  ' "$STEPS"
}

apply_take() {
  local t="${DEMO_TAKE:-1}"
  case "$t" in ''|*[!0-9]*) die "DEMO_TAKE must be a number" ;; esac
  if [ "$t" != "1" ]; then
    printf '%s' "$1" | sed "s/-video-demo/-video-demo-t$t/g"
  else
    printf '%s' "$1"
  fi
}

rec_running() {
  local p
  p="$(cat "$KIT/.rec.pid" 2>/dev/null)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

copy_step() {
  local n="$1" total kind label text
  total="$(step_count)"
  case "$n" in ''|*[!0-9]*) die "step must be a number from 1 to $total" ;; esac
  { [ "$n" -ge 1 ] && [ "$n" -le "$total" ]; } || die "step must be 1..$total (./demo.sh list)"
  kind="$(step_get "$n" kind)"
  label="$(step_get "$n" label)"
  text="$(apply_take "$(step_get "$n" text)")"
  case "$DEMO_ACCOUNT:$EXPECTED_CLIENT_ID" in
    *YOUR_*|:*|*:) die "Configure the demo account/client IDs in the local demo.sh first." ;;
  esac
  printf '%s' "$text" | grep -q 'YOUR_' \
    && die "Replace account placeholders in the local steps.txt first."
  if printf '%s' "$text" | grep -Eq 'calendar_(create|update|delete)_event'; then
    rec_running || die "A write step requires a running recording; extra rehearsal writes are not approved."
    local plan
    plan="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$PLAN_EVENT_UTC" +%s 2>/dev/null)"
    [ -n "$plan" ] && [ "$(date -u +%s)" -lt $((plan - 3600)) ] \
      || die "Refresh and approve the event plan in demo.sh and steps.txt before recording."
    printf '%s' "$(step_get 6 text)" | grep -Fq "timed event from $PLAN_EVENT_UTC to " \
      || die "PLAN_EVENT_UTC must match the approved create time in steps.txt."
  fi
  printf '%s' "$text" | pbcopy
  printf '%s\n' "$n" > "$KIT/.step"
  printf '\nStep %s of %s  [%s]  %s\n\n  %s\n\n' "$n" "$total" "$kind" "$label" "$text"
  if [ "$kind" = shell ]; then
    echo "  Copied. In the STAGE window: Cmd+V, then Return."
  else
    echo "  Copied. In the Copilot prompt in the STAGE window: Cmd+V, then Return."
  fi
  echo
}

cmd_list() {
  awk -F'[|]' '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^## / { n = $1; sub(/^## /, "", n); printf "  %2s  %-6s %s\n", trim(n), trim($2), trim($3) }
  ' "$STEPS"
}

cmd_next() {
  local cur total
  cur="$(cat "$KIT/.step" 2>/dev/null)"; cur="${cur:-0}"
  total="$(step_count)"
  if [ "$cur" -ge "$total" ]; then
    echo "All $total steps are done. Next: ./demo.sh record stop, then ./demo.sh finalize"
    return 0
  fi
  copy_step $((cur + 1))
}

cmd_again() { local cur; cur="$(cat "$KIT/.step" 2>/dev/null)"; copy_step "${cur:-1}"; }
cmd_back()  { local cur; cur="$(cat "$KIT/.step" 2>/dev/null)"; cur="${cur:-1}"; [ "$cur" -gt 1 ] && cur=$((cur - 1)); copy_step "$cur"; }
cmd_reset() { echo 0 > "$KIT/.step"; echo "Back at the start. Next step: 1 (take ${DEMO_TAKE:-1})"; }

cmd_show() {
  local n="${1:-}"
  [ -n "$n" ] || die "usage: ./demo.sh show N"
  printf '[%s] %s\n%s\n' "$(step_get "$n" kind)" "$(step_get "$n" label)" "$(apply_take "$(step_get "$n" text)")"
}

# --------------------------------------------------------------------------- preflight

cmd_preflight() {
  local fails=0 warns=0 live=""
  [ "${1:-}" = "--live" ] && live=1
  _ok()   { printf '  [ ok ] %s\n' "$*"; }
  _bad()  { printf '  [FAIL] %s\n' "$*"; fails=$((fails + 1)); }
  _warn() { printf '  [warn] %s\n' "$*"; warns=$((warns + 1)); }
  _info() { printf '  [ .. ] %s\n' "$*"; }

  echo "== Tools"
  if [ -x "$FFMPEG" ]; then
    _ok "ffmpeg $("$FFMPEG" -version 2>/dev/null | head -1 | awk '{print $3}')"
    "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -q libx264 && _ok "libx264 encoder available" || _bad "ffmpeg has no libx264 encoder"
  else
    _bad "ffmpeg not found (brew install ffmpeg)"
  fi
  [ -x "$FFPROBE" ] && _ok "ffprobe present" || _bad "ffprobe not found"
  if have node; then _ok "node $(node --version)"; else _bad "node not found in PATH"; fi
  [ -n "$PY3" ] && _ok "python3 present (display queries)" || _bad "python3 not found"
  local cop; cop="$(newest_copilot)"
  if [ -x "$cop" ]; then _ok "standalone Copilot CLI: $("$cop" --version 2>/dev/null | head -1)  ($cop)"; else _bad "standalone Copilot CLI not found under ~/.copilot-cli"; fi
  if [ -x "$CONNECTOR_BIN" ]; then
    _ok "google-connector $(node -p "require('$CONNECTOR_DIR/node_modules/copilot-google-connector/package.json').version" 2>/dev/null)  ($CONNECTOR_BIN)"
  else
    _bad "google-connector not installed at $CONNECTOR_DIR"
  fi
  if [ -d /Applications/Ghostty.app ]; then
    _ok "Ghostty $(defaults read /Applications/Ghostty.app/Contents/Info CFBundleShortVersionString 2>/dev/null)"
    if /Applications/Ghostty.app/Contents/MacOS/ghostty +validate-config --config-file="$KIT/ghostty.conf" >/dev/null 2>&1; then
      _ok "stage window config is valid"
    else
      _bad "ghostty.conf failed validation"
    fi
  else
    _bad "Ghostty.app not found in /Applications"
  fi

  echo "== Stage shell and Copilot profile"
  local chk mcp
  chk="$("$KIT/bin/stage-shell" --check 2>&1)"
  echo "$chk" | grep -q "^copilot -> $KIT/bin/copilot\$" && _ok "copilot resolves to the kit wrapper" || _bad "copilot does not resolve to the kit wrapper"
  echo "$chk" | grep -q '^alias copilot: none' && _ok "no copilot alias in the stage shell" || _bad "an alias named copilot exists in the stage shell"
  echo "$chk" | grep -q "^google-connector -> $CONNECTOR_BIN\$" && _ok "google-connector resolves to the installed connector" || _bad "google-connector does not resolve to the installed connector"
  if [ -x "$cop" ]; then
    mcp="$(COPILOT_HOME="$KIT/home" "$cop" --no-auto-update mcp list 2>&1)"
    if echo "$mcp" | grep -q 'google-local'; then _ok "isolated profile has the google-local MCP server"; else _bad "google-local missing from the isolated profile"; fi
    local others
    others="$(echo "$mcp" | awk '/^User servers:/ {u = 1; next} /^[A-Za-z]/ {u = 0} u && NF && $1 != "google-local" {n++} END {print n + 0}')"
    [ "$others" = "0" ] && _ok "no other user MCP servers in the isolated profile (built-in ones are switched off by bin/copilot)" || _warn "the isolated profile lists other user MCP servers - check: COPILOT_HOME=$KIT/home copilot mcp list"
  fi

  if grep -q '"appInstallNudgeResponded": *true' "$KIT/home/config.json" 2>/dev/null; then
    _ok "the desktop-app install prompt is already dismissed in the demo profile"
  else
    _bad "the demo profile would show a full-screen 'Install it now?' prompt - add \"appInstallNudgeResponded\": true to home/config.json (press N there, NEVER Enter: Enter installs/launches the desktop app)"
  fi

  echo "== Demo account $DEMO_ACCOUNT"
  case "$DEMO_ACCOUNT:$EXPECTED_CLIENT_ID" in
    *YOUR_*|:*|*:) _bad "configure account/client IDs in the local demo.sh" ;;
  esac
  grep -q 'YOUR_' "$STEPS" && _bad "replace account placeholders in the local steps.txt"
  local acct
  acct="$("$CONNECTOR_BIN" accounts list 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j; try { j = JSON.parse(s); } catch (e) { console.log("UNPARSEABLE"); return; }
      const list = Array.isArray(j) ? j : (j.accounts || []);
      const a = list.find(x => (x.accountId || x.id) === process.argv[1]);
      if (!a) { console.log("MISSING"); return; }
      console.log("EMAIL " + a.email);
      for (const sc of (a.scopes || [])) console.log("SCOPE " + sc.replace("https://www.googleapis.com/auth/", ""));
      console.log("GMAIL " + (a.gmailConfigured ? "yes" : "no"));
    })' "$DEMO_ACCOUNT" 2>/dev/null)"
  if [ -z "$acct" ] || [ "$acct" = "MISSING" ] || [ "$acct" = "UNPARSEABLE" ]; then
    _bad "demo account not found in the connector (./demo.sh must run as the same macOS user)"
  else
    _ok "$(echo "$acct" | sed -n 's/^EMAIL /email: /p')"
    local sc
    for sc in calendar.calendarlist.readonly calendar.events calendar.events.freebusy; do
      echo "$acct" | grep -qx "SCOPE $sc" && _ok "scope granted: $sc" || _warn "scope NOT granted yet: $sc (the recorded reauth step will grant it)"
    done
    echo "$acct" | grep -q '^SCOPE gmail' && _bad "the demo account still has Gmail scopes - it must be Calendar-only for the video" || _ok "no Gmail scopes on the demo account"
    echo "$acct" | grep -qx 'GMAIL yes' && _warn "the demo account has a Gmail app password stored (not used by any allowed tool)"
  fi
  _info "consent URL must show client_id=$EXPECTED_CLIENT_ID"

  echo "== Time"
  local now plan
  now="$(date -u +%s)"
  plan="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$PLAN_EVENT_UTC" +%s 2>/dev/null)"
  if [ -n "$plan" ]; then
    if [ "$now" -ge $((plan - 3600)) ]; then
      _bad "approved event time $PLAN_EVENT_UTC is within an hour or already past - ask for a revised event plan before recording"
    else
      _ok "approved event time $PLAN_EVENT_UTC is $(( (plan - now) / 3600 )) h ahead"
    fi
  else
    _bad "PLAN_EVENT_UTC is invalid; use a newly approved UTC timestamp"
  fi

  echo "== Displays and Screen Recording"
  local info access=""
  info="$(display_info 2>/dev/null)"
  access="$(echo "$info" | sed -n 's/^ACCESS //p')"
  if [ -z "$(echo "$info" | grep '^DISPLAY')" ]; then
    _bad "no active displays reported (screen locked or asleep). Unlock the Mac and re-run."
  else
    echo "$info" | grep '^DISPLAY' | while read -r _ idx rest; do
      local w h ratio note=""
      w="$(echo "$rest" | sed -n 's/.* w=\([0-9]*\).*/\1/p')"
      h="$(echo "$rest" | sed -n 's/.* h=\([0-9]*\).*/\1/p')"
      [ -n "$w" ] && [ -n "$h" ] && [ $((w * 9)) -eq $((h * 16)) ] && note="  <- 16:9, best capture target"
      echo "$rest" | grep -q 'main=1' && note="$note  (main display)"
      echo "$rest" | grep -q 'builtin=1' && note="$note  (built-in)"
      printf '  [ .. ] Capture screen %s: %sx%s points%s\n' "$idx" "$w" "$h" "$note"
    done
    display_names | sed 's/^/           /'
  fi
  case "$access" in
    1)  _ok "Screen Recording is granted to the app running this terminal" ;;
    0)  _bad "Screen Recording is NOT granted to the app running this terminal (System Settings > Privacy & Security), then quit and reopen it" ;;
    *)  _warn "could not determine Screen Recording permission" ;;
  esac
  local devs; devs="$(capture_devices | wc -l | tr -d ' ')"
  [ "$devs" -gt 0 ] 2>/dev/null && _ok "ffmpeg sees $devs capture screen(s)" || _bad "ffmpeg sees no capture screens"
  if [ -f "$KIT/.screen" ]; then _ok "recording target: Capture screen $(cat "$KIT/.screen")"; else _warn "no recording display chosen yet: ./demo.sh screen N"; fi

  echo "== Browser"
  local hb
  hb="$("$PY3" - <<'PY'
import plistlib, os
p = os.path.expanduser("~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
try:
    with open(p, "rb") as f:
        d = plistlib.load(f)
    for h in d.get("LSHandlers", []):
        if h.get("LSHandlerURLScheme") == "https":
            print(h.get("LSHandlerRoleAll", "unknown"))
            break
    else:
        print("unknown")
except Exception:
    print("unknown")
PY
)"
  _info "default browser (the connector opens it): $hb"
  _info "it must be signed in ONLY as the demo Google account, in a wide window on the recorded display"

  if [ -n "$live" ] && [ -x "$cop" ]; then
    echo "== Live agent check (uses one model request)"
    "$KIT/bin/copilot" -s -p "Reply with exactly the word READY and call no tools." 2>&1 | tail -3 | sed 's/^/    /'
  fi

  echo "== Before you record"
  cat <<'EOF'
  - Turn on Do Not Disturb; quit chat, mail and anything that shows notifications.
  - Do not show credentials. Stop the recording before typing a password or app password.
  - Do not run "accounts list" on camera (it lists other accounts). Use only the steps in ./demo.sh list.
EOF
  echo
  if [ "$fails" -gt 0 ]; then printf 'RESULT: %d problem(s) to fix, %d warning(s)\n' "$fails" "$warns"; return 1; fi
  printf 'RESULT: ready (%d warning(s))\n' "$warns"
}

# --------------------------------------------------------------------------- display / stage

cmd_snapshot() {
  local devs dir stamp
  devs="$(capture_devices)"
  [ -n "$devs" ] || die "ffmpeg sees no capture screens (screen locked or asleep?). Unlock and retry."
  dir="$OUT/snapshots"; mkdir -p "$dir"
  rm -f "$dir"/screen*.png "$dir"/screen*.jpg
  stamp="$(date +%H%M%S)"
  echo "One frame from every display (this can show anything visible on that display):"
  echo "$devs" | while read -r idx n; do
    local png="$dir/screen$n-$stamp.png" jpg="$dir/screen$n-$stamp.jpg"
    "$FFMPEG" -hide_banner -loglevel error -nostdin -y -f avfoundation -pixel_format uyvy422 -framerate 30 -capture_cursor 1 -i "$idx:none" -frames:v 1 "$png" 2>&1 \
      | grep -v 'NSKVONotifying_AVCaptureScreenInput' || true
    if [ -s "$png" ]; then
      sips -Z 1920 -s format jpeg "$png" --out "$jpg" >/dev/null 2>&1 && rm -f "$png"
      printf '  Capture screen %s  %s\n' "$n" "${jpg/#$KIT\//}"
    else
      printf '  Capture screen %s  FAILED (see the message above)\n' "$n"
    fi
  done
  screen_access_note "A display showing only the wallpaper simply has no windows on it (expected for the empty stage display)."
}

cmd_screen() {
  local n="${1:-}"
  if [ -z "$n" ]; then
    if [ -f "$KIT/.screen" ]; then echo "recording target: Capture screen $(cat "$KIT/.screen")"; else echo "no display chosen yet: ./demo.sh screen N   (see ./demo.sh preflight)"; fi
    return 0
  fi
  case "$n" in ''|*[!0-9]*) die "screen must be a number" ;; esac
  if [ -z "${DEMO_SYNTH:-}" ]; then
    capture_devices | awk -v n="$n" '$2 == n { f = 1 } END { exit !f }' || die "Capture screen $n not found (locked screen? ./demo.sh preflight)"
  fi
  echo "$n" > "$KIT/.screen"
  echo "Will record Capture screen $n"
}

cmd_stage() {
  local font="${DEMO_FONT_SIZE:-28}"
  have node || die "node not found in PATH"
  [ -d /Applications/Ghostty.app ] || die "Ghostty.app not found in /Applications"
  dirname "$(command -v node)" > "$KIT/.node-dir"
  mkdir -p "$KIT/work"
  if [ "${1:-}" = "--here" ]; then exec "$KIT/bin/stage-shell"; fi
  open -na Ghostty --args \
    "--config-default-files=false" \
    "--config-file=$KIT/ghostty.conf" \
    "--font-size=$font" \
    "--command=direct:$KIT/bin/stage-shell" \
    "--working-directory=$KIT/work"
  cat <<'EOF'
Stage window launched (a separate Ghostty instance with its own clean settings).
Keep running ./demo.sh commands in THIS control terminal. The stage window is only for the recorded demo.
  1. Drag it to the display you chose with ./demo.sh screen N.
  2. Press Ctrl+Cmd+F for full screen (hides the menu bar and Dock).
  3. Put the browser in its own full-screen Space on that same display (Ctrl+Left/Right switches Spaces).
Close the stage window when finished; it quits by itself.
EOF
}

# --------------------------------------------------------------------------- recording

session_dir() { cat "$KIT/.session" 2>/dev/null; }

# Sets CAP_INPUT (ffmpeg input arguments), CAP_VF (filter chain) and CAP_LABEL for the chosen display.
build_capture() {
  local screen dev crop=""
  if [ -n "${DEMO_SYNTH:-}" ]; then
    CAP_INPUT=(-re -f lavfi -i "testsrc2=size=2560x1440:rate=30")
    CAP_LABEL="the synthetic test source"
  else
    screen="$(cat "$KIT/.screen" 2>/dev/null)"
    [ -n "$screen" ] || die "choose the display first: ./demo.sh screen N  (see ./demo.sh preflight)"
    dev="$(capture_devices | awk -v n="$screen" '$2 == n { print $1 }')"
    [ -n "$dev" ] || die "Capture screen $screen not found (screen locked or the display was unplugged)"
    CAP_INPUT=(-f avfoundation -pixel_format uyvy422 -framerate 30 -capture_cursor 1 -capture_mouse_clicks 1 -i "$dev:none")
    CAP_LABEL="Capture screen $screen"
  fi
  [ -n "${DEMO_CROP_TOP:-}" ] && crop="crop=iw:ih-${DEMO_CROP_TOP}:0:${DEMO_CROP_TOP},"
  CAP_VF="${crop}scale=w='min(2560,iw)':h=-2:flags=bicubic,format=yuv420p"
}

# Prints the encoder speed from an ffmpeg log and warns when the capture could not keep up in real time.
# (Duplicated frames are normal while the screen is static, so they are not reported.)
report_capture_stats() {
  local line speed
  [ -f "$1" ] || return 0
  line="$(tr '\r' '\n' < "$1" | grep 'speed=' | tail -1)"
  speed="$(echo "$line" | sed -n 's/.*speed= *\([0-9.]*\)x.*/\1/p')"
  [ -n "$speed" ] || return 0
  printf '  encoder speed: %sx real time\n' "$speed"
  if awk -v s="$speed" 'BEGIN { exit !(s < 0.95) }'; then
    yellow "  WARNING: the encoder fell behind real time, so this part may look choppy. Close other heavy apps or lower the display resolution."
  fi
}

cmd_record_start() {
  [ -x "$FFMPEG" ] || die "ffmpeg not found"
  rec_running && die "already recording (pid $(cat "$KIT/.rec.pid")); ./demo.sh record stop first"
  local dir n part log
  build_capture
  dir="$(session_dir)"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    dir="$OUT/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir"
    echo "$dir" > "$KIT/.session"
  fi
  n=$(( $(ls "$dir"/part-*.mkv 2>/dev/null | wc -l | tr -d ' ') + 1 ))
  part="$dir/$(printf 'part-%03d.mkv' "$n")"
  log="$dir/$(printf 'part-%03d.log' "$n")"
  local secs="${DEMO_COUNTDOWN:-5}"
  case "$secs" in ''|*[!0-9]*) secs=5 ;; esac
  if [ "$secs" -gt 0 ]; then
    echo "Recording part $n starts in $secs s. Click the STAGE window now and keep private windows off that display."
    while [ "$secs" -gt 0 ]; do printf '\r  %s ' "$secs"; sleep 1; secs=$((secs - 1)); done
    printf '\r    \r'
  fi

  nohup "$FFMPEG" -hide_banner -nostdin -y "${CAP_INPUT[@]}" -vf "$CAP_VF" \
    -c:v libx264 -preset ultrafast -crf 17 -g 60 -pix_fmt yuv420p -r 30 -fps_mode cfr "$part" >"$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$KIT/.rec.pid"
  have caffeinate && { caffeinate -di -w "$pid" >/dev/null 2>&1 & }

  local i=0
  while [ "$i" -lt 20 ]; do
    sleep 0.5
    kill -0 "$pid" 2>/dev/null || { echo "ffmpeg exited early:"; tail -8 "$log"; rm -f "$KIT/.rec.pid"; return 1; }
    [ "$(file_size "$part")" -gt 4096 ] && break
    i=$((i + 1))
  done
  if [ "$(file_size "$part")" -le 4096 ]; then
    echo "No video data yet. Last log lines:"; tail -5 "$log"
    kill -INT "$pid" 2>/dev/null; rm -f "$KIT/.rec.pid"
    return 1
  fi
  echo "RECORDING part $n (pid $pid) -> $part"
  echo "Stop with: ./demo.sh record stop"
}

cmd_record_stop() {
  local pid dir last i=0
  pid="$(cat "$KIT/.rec.pid" 2>/dev/null)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then echo "not recording"; rm -f "$KIT/.rec.pid"; return 0; fi
  kill -INT "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
  kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
  rm -f "$KIT/.rec.pid"
  dir="$(session_dir)"
  last="$(ls "$dir"/part-*.mkv 2>/dev/null | tail -1)"
  echo "Stopped. $(basename "$last"): $(duration_of "$last") s, $(( $(file_size "$last") / 1048576 )) MB"
  report_capture_stats "${last%.mkv}.log"
}

cmd_record_status() {
  local dir f
  if rec_running; then echo "recording: yes (pid $(cat "$KIT/.rec.pid"))"; else echo "recording: no"; fi
  dir="$(session_dir)"
  [ -n "$dir" ] && [ -d "$dir" ] || { echo "session: none"; return 0; }
  echo "session: $dir"
  for f in "$dir"/part-*.mkv; do
    [ -e "$f" ] || continue
    printf '  %s  %s s  %s MB\n' "$(basename "$f")" "$(duration_of "$f")" "$(( $(file_size "$f") / 1048576 ))"
  done
  if [ -f "$dir/chatter-calendar-demo.mp4" ]; then
    echo "  final: $dir/chatter-calendar-demo.mp4"
  fi
}

cmd_record_drop() {
  rec_running && die "stop the recording first"
  local dir last
  dir="$(session_dir)"
  last="$(ls "$dir"/part-*.mkv 2>/dev/null | tail -1)"
  [ -n "$last" ] || die "no parts to drop"
  mkdir -p "$dir/discarded"
  mv "$last" "$dir/discarded/"
  echo "Moved $(basename "$last") to $dir/discarded/"
}

cmd_record() {
  case "${1:-status}" in
    start)  cmd_record_start ;;
    stop)   cmd_record_stop ;;
    status) cmd_record_status ;;
    drop)   cmd_record_drop ;;
    new)    rec_running && die "stop the recording first"; rm -f "$KIT/.session"; echo "Next 'record start' begins a new session." ;;
    *)      die "usage: ./demo.sh record start|stop|status|drop|new" ;;
  esac
}

cmd_capture_test() {
  [ -x "$FFMPEG" ] || die "ffmpeg not found"
  rec_running && die "a recording is running; ./demo.sh record stop first"
  local secs="${1:-8}" wait="${DEMO_COUNTDOWN:-5}" dir clip log i t
  case "$secs" in ''|*[!0-9]*) die "usage: ./demo.sh capture-test [seconds]" ;; esac
  [ "$secs" -ge 4 ] || die "use at least 4 seconds"
  case "$wait" in ''|*[!0-9]*) wait=5 ;; esac
  build_capture
  dir="$OUT/capture-test"
  rm -rf "$dir"; mkdir -p "$dir"
  clip="$dir/test.mkv"; log="$dir/test.log"
  echo "Test capture of $CAP_LABEL for $secs s. It is separate from any real recording and only two frames are kept."
  echo "Show the stage window on that display and move the mouse over it."
  while [ "$wait" -gt 0 ]; do printf '\r  starting in %s ' "$wait"; sleep 1; wait=$((wait - 1)); done
  printf '\r                    \r'
  "$FFMPEG" -hide_banner -nostdin -y "${CAP_INPUT[@]}" -t "$secs" -vf "$CAP_VF" \
    -c:v libx264 -preset ultrafast -crf 17 -g 60 -pix_fmt yuv420p -r 30 -fps_mode cfr "$clip" >"$log" 2>&1 \
    || { tail -8 "$log"; die "test capture failed (see the message above)"; }
  echo "Captured $(duration_of "$clip") s at $("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$clip")."
  report_capture_stats "$log"
  i=1
  for t in $((secs / 3)) $((secs * 2 / 3)); do
    "$FFMPEG" -hide_banner -loglevel error -nostdin -y -ss "$t" -i "$clip" -frames:v 1 -vf "scale='min(1920,iw)':-2" -q:v 3 "$dir/frame-$i.jpg"
    [ -s "$dir/frame-$i.jpg" ] && echo "  frame at ${t}s: $dir/frame-$i.jpg"
    i=$((i + 1))
  done
  rm -f "$clip"
  screen_access_note "If the stage window is missing from a frame, it is not on the recorded display."
}

cmd_finalize() {
  rec_running && die "stop the recording first: ./demo.sh record stop"
  local dir list final f
  dir="$(session_dir)"
  [ -n "$dir" ] && [ -d "$dir" ] || die "no recording session"
  list="$dir/concat.txt"; : > "$list"
  for f in "$dir"/part-*.mkv; do
    [ -e "$f" ] || continue
    printf "file '%s'\n" "$f" >> "$list"
  done
  [ -s "$list" ] || die "no parts to join"
  final="$dir/chatter-calendar-demo.mp4"
  "$FFMPEG" -hide_banner -loglevel error -stats -stats_period 2 -nostdin -y -f concat -safe 0 -i "$list" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart -an "$final" || die "ffmpeg failed"
  echo
  "$FFPROBE" -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate:format=duration,size -of default=nw=1 "$final"
  echo "Final video: $final"
  echo "Reveal in Finder: open -R '$final'"
}

cmd_review() {
  local secs="${1:-5}" dir src
  case "$secs" in ''|*[!0-9]*) die "usage: ./demo.sh review [seconds-between-frames]" ;; esac
  dir="$(session_dir)"
  src="$dir/chatter-calendar-demo.mp4"
  [ -f "$src" ] || die "run ./demo.sh finalize first"
  mkdir -p "$dir/review"
  rm -f "$dir/review"/frame-*.jpg "$dir/review"/sheet-*.jpg
  "$FFMPEG" -hide_banner -loglevel error -nostdin -y -i "$src" -vf "fps=1/$secs,scale=1600:-2" -q:v 3 "$dir/review/frame-%04d.jpg"
  "$FFMPEG" -hide_banner -loglevel error -nostdin -y -i "$src" -vf "fps=1/$secs,scale=640:-2,tile=3x3:padding=4" -q:v 3 "$dir/review/sheet-%02d.jpg"
  echo "Frames (one every $secs s, frame N is at $secs*(N-1) s): $dir/review/frame-NNNN.jpg"
  echo "Contact sheets (9 frames each):                      $dir/review/sheet-NN.jpg"
}

cmd_frame() {
  local t="${1:-}" dir src out
  [ -n "$t" ] || die "usage: ./demo.sh frame SECONDS"
  dir="$(session_dir)"; src="$dir/chatter-calendar-demo.mp4"
  [ -f "$src" ] || die "run ./demo.sh finalize first"
  out="$dir/review/frame-at-$t.png"; mkdir -p "$dir/review"
  "$FFMPEG" -hide_banner -loglevel error -nostdin -y -ss "$t" -i "$src" -frames:v 1 "$out" && echo "$out"
}

cmd_status() {
  printf 'kit:        %s\n' "$KIT"
  printf 'take:       %s\n' "${DEMO_TAKE:-1}"
  printf 'step:       %s of %s done\n' "$(cat "$KIT/.step" 2>/dev/null || echo 0)" "$(step_count)"
  if [ -f "$KIT/.screen" ]; then printf 'screen:     Capture screen %s\n' "$(cat "$KIT/.screen")"; else printf 'screen:     not chosen\n'; fi
  cmd_record_status
}

cmd_help() {
  cat <<'EOF'
Chatter local connector - Google OAuth verification demo kit

Two windows
  control  your normal Ghostty, on a display that is NOT recorded. Run ./demo.sh from here.
  stage    a clean, recorded Ghostty window (./demo.sh stage), full screen on the recorded display.

One-time setup
  1. System Settings > Privacy & Security > Screen & System Audio Recording: turn Ghostty on,
     then quit and reopen Ghostty (the stage window shares this permission).
  2. Turn on Do Not Disturb; quit chat, mail and any app that shows notifications.
  3. Browser: sign in ONLY as the demo Google account in the profile that is your default browser
     (the connector opens the default browser). Put it in its own full-screen Space on the recorded
     display, wide enough that the address bar shows the whole client_id.
  4. ./demo.sh preflight        check tools, demo account scopes, displays, permission
  5. ./demo.sh snapshot         one frame per display - confirm real windows show (not just wallpaper)
  6. ./demo.sh screen N         choose the display to record (a 16:9 display is best)
  7. ./demo.sh stage            open the stage window; drag it to that display, press Ctrl+Cmd+F
  8. ./demo.sh capture-test     8 s test capture of that display: encoder speed plus two frames to check

Recording (from the control terminal)
  ./demo.sh record start        5 s countdown, then recording; click the stage window
  ./demo.sh next                copy the next step; paste it with Cmd+V in the stage window
  ./demo.sh record stop         pause (for example before typing anything secret); start again to add a part
  ./demo.sh record drop         discard the most recent part after a mistake
  ./demo.sh finalize            join the parts into chatter-calendar-demo.mp4
  ./demo.sh review [secs]       extract frames and contact sheets to check for private data
  ./demo.sh frame SECONDS       extract one full-resolution frame

Other
  ./demo.sh list | show N | clip N | again | back | reset | status | preflight --live
  env: DEMO_FONT_SIZE (28)  DEMO_COUNTDOWN (5)  DEMO_TAKE (1; use 2 for a second take)  DEMO_OUT (./out)
       DEMO_MODEL  DEMO_EXTRA_TOOLS="calendar_list_events"  DEMO_SYNTH=1 (test recording without the screen)
EOF
}

case "${1:-help}" in
  help|-h|--help) cmd_help ;;
  preflight)      shift; cmd_preflight "$@" ;;
  snapshot)       cmd_snapshot ;;
  capture-test)   shift; cmd_capture_test "$@" ;;
  screen)         shift; cmd_screen "$@" ;;
  stage)          shift; cmd_stage "$@" ;;
  list)           cmd_list ;;
  show)           shift; cmd_show "$@" ;;
  clip)           shift; if [ "${1:-}" = list ] || [ -z "${1:-}" ]; then cmd_list; else copy_step "$1"; fi ;;
  next)           cmd_next ;;
  again)          cmd_again ;;
  back)           cmd_back ;;
  reset)          cmd_reset ;;
  record)         shift; cmd_record "$@" ;;
  finalize)       cmd_finalize ;;
  review)         shift; cmd_review "$@" ;;
  frame)          shift; cmd_frame "$@" ;;
  status)         cmd_status ;;
  *)              die "unknown command '$1' (./demo.sh help)" ;;
esac
