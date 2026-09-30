# Clean prompt and caption helper for the recorded window.
setopt PROMPT_SUBST INTERACTIVE_COMMENTS NO_BEEP
unsetopt CORRECT CORRECT_ALL 2>/dev/null
HISTFILE=/dev/null
HISTSIZE=200
SAVEHIST=0
PROMPT='%F{51}$%f '
RPROMPT=''

# note Some caption text   (avoid parentheses, quotes and semicolons when unquoted)
note() {
  print -n -P '\n%K{24}%F{15}%B  '
  print -n -r -- "$*"
  print -P '  %b%f%k\n'
}

connector_version="$(node -p "require(process.env.HOME + '/.local/share/copilot-google-connector/node_modules/copilot-google-connector/package.json').version" 2>/dev/null)"

cd "$KIT/work"
[[ -n "$DEMO_CHECK" ]] && return 0
clear
note "Chatter local Copilot connector ${connector_version:+v$connector_version} - Google OAuth verification demo"
