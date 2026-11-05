#!/bin/sh
# Run one Codex task non-interactively from the repository root.
#
#   tools/codex/run.sh <task-dir> <name> [low|medium|high]
#
# Reads <task-dir>/<name>.body.md, prepends preamble.md and appends rules.md
# (skip rules.md by creating <task-dir>/<name>.norules), and writes
# <name>.prompt.md, <name>.log and <name>.result.md (Codex's final message)
# into <task-dir>. Keep <task-dir> outside the repository.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dir="$1"
name="$2"
effort="${3:-high}"

if [ -f "$dir/$name.norules" ]; then
  cat "$here/preamble.md" "$dir/$name.body.md" > "$dir/$name.prompt.md"
else
  cat "$here/preamble.md" "$dir/$name.body.md" "$here/rules.md" > "$dir/$name.prompt.md"
fi

cd "$root"
codex exec -m gpt-6.1-sol -c model_reasoning_effort="$effort" -c project_doc_max_bytes=0 \
  --dangerously-bypass-approvals-and-sandbox --color never \
  -o "$dir/$name.result.md" - < "$dir/$name.prompt.md" > "$dir/$name.log" 2>&1
status=$?
echo "$name exit $status"
exit $status
