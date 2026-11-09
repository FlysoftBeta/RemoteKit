#!/bin/sh
# Run one Codex task non-interactively from the repository root.
#
#   tools/codex/run.sh <task-dir> <name> [low|medium|high] [--resume <prior-name>]
#
# Reads <task-dir>/<name>.body.md, prepends preamble.md and appends rules.md
# (skip rules.md by creating <task-dir>/<name>.norules), and writes
# <name>.prompt.md, <name>.log, <name>.session (the conversation id) and
# <name>.result.md (Codex's final message) into <task-dir>. Keep <task-dir>
# outside the repository.
#
# --resume continues the conversation of an earlier run <prior-name> in the
# same <task-dir> instead of starting a new one: the body is sent as the next
# message, without preamble.md (the conversation already has it); rules.md is
# still appended unless <name>.norules exists.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dir="$1"
name="$2"
effort="${3:-high}"
prior=""
if [ "${4:-}" = "--resume" ]; then
  prior="${5:?--resume needs the name of an earlier run}"
fi

session_of() {
  grep -a -m1 '^session id:' "$1" 2>/dev/null | awk '{print $3}' | tr -d '\r'
}

parts="$dir/$name.body.md"
[ -n "$prior" ] || parts="$here/preamble.md $parts"
[ -f "$dir/$name.norules" ] || parts="$parts $here/rules.md"
# shellcheck disable=SC2086
cat $parts > "$dir/$name.prompt.md"

cd "$root"
if [ -n "$prior" ]; then
  id="$(cat "$dir/$prior.session" 2>/dev/null || session_of "$dir/$prior.log")"
  if [ -z "$id" ]; then
    echo "no session id for $prior" >&2
    exit 2
  fi
  codex exec resume -m gpt-6.1-sol -c model_reasoning_effort="$effort" -c project_doc_max_bytes=0 \
    --dangerously-bypass-approvals-and-sandbox \
    -o "$dir/$name.result.md" "$id" - < "$dir/$name.prompt.md" > "$dir/$name.log" 2>&1
else
  codex exec -m gpt-6.1-sol -c model_reasoning_effort="$effort" -c project_doc_max_bytes=0 \
    --dangerously-bypass-approvals-and-sandbox --color never \
    -o "$dir/$name.result.md" - < "$dir/$name.prompt.md" > "$dir/$name.log" 2>&1
fi
status=$?
id="${id:-$(session_of "$dir/$name.log")}"
[ -n "$id" ] && echo "$id" > "$dir/$name.session"
echo "$name exit $status session ${id:-unknown}"
exit $status
