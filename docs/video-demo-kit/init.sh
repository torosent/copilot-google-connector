#!/bin/bash
set -euo pipefail
umask 077

SOURCE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/.local/share/copilot-google-connector-video-demo}"
case "$DEST" in
  /*) ;;
  *) echo "error: choose an absolute destination outside the repository" >&2; exit 1 ;;
esac
[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || { echo "error: destination already exists: $DEST" >&2; exit 1; }
command -v node >/dev/null || { echo "error: Node.js is required" >&2; exit 1; }

node --input-type=module - "$SOURCE/../.." "$DEST" <<'JS'
import fs from "node:fs";
import path from "node:path";
const repo = fs.realpathSync(process.argv[2]);
let ancestor = path.dirname(process.argv[3]);
while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
const realAncestor = fs.realpathSync(ancestor);
const relative = path.relative(repo, realAncestor);
if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
  throw new Error("Keep the private runtime outside the repository.");
}
JS

mkdir -p "$DEST/bin" "$DEST/zdot" "$DEST/work" "$DEST/home"
cp "$SOURCE/demo.sh" "$SOURCE/steps.txt" "$SOURCE/ghostty.conf" "$DEST/"
cp "$SOURCE/bin/copilot" "$SOURCE/bin/stage-shell" "$DEST/bin/"
cp "$SOURCE/zdot/.zshrc" "$DEST/zdot/"
chmod 700 "$DEST/demo.sh" "$DEST/bin/copilot" "$DEST/bin/stage-shell"

node --input-type=module - "$DEST" <<'JS'
import fs from "node:fs";
import path from "node:path";
const dest = fs.realpathSync(process.argv[2]);
const write = (name, value) => fs.writeFileSync(path.join(dest, "home", name),
  JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
write("config.json", {
  appInstallNudgeResponded: true,
  trustedFolders: [path.join(dest, "work")]
});
write("settings.json", {
  autoUpdate: false, banner: "never", showTipsOnStartup: false,
  streamerMode: true, theme: "default", beep: false, notifications: false,
  terminalNotifications: false, updateTerminalTitle: false, mouse: false,
  compactPaste: false, ide: { autoConnect: false, openDiffOnEdit: false },
  tabs: { enabled: false }, footer: {
    showAgent: false, showBranch: false, showCodeChanges: false,
    showContextWindow: false, showCustom: false, showDirectory: false,
    showModelEffort: true, showQuota: false
  }, experimental: false
});
write("mcp-config.json", { mcpServers: { "google-local": {
  type: "local", command: process.execPath,
  args: [path.join(process.env.HOME, ".local/share/copilot-google-connector",
    "node_modules/copilot-google-connector/dist/cli.js"), "serve"],
  env: {}, tools: ["*"], timeout: 120000
} } });
fs.writeFileSync(path.join(dest, ".node-dir"), path.dirname(process.execPath) + "\n");
JS

printf 'Private runtime created: %s\n' "$DEST"
echo "Next: configure account/client IDs and a newly approved future plan in demo.sh and steps.txt."
echo "Authenticate Copilot outside recording if needed; see the repository kit README."
