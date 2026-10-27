#!/bin/zsh
# Claude Code in a folder (runners/README.md): the workflow's prompt given to Claude Code in the
# workflow's folder, with copies of the recording's transcript to read. Started by
# native/supervise.ts with RESCRIBE_RUN_DIR, RESCRIBE_FOLDER, RESCRIBE_PROMPT and RESCRIBE_WORKFLOW.
# The last line it prints is what the human reads when it fails.
#
# What was said on the call is not trusted: anyone on it can talk to the agent that reads it. So
# Claude Code runs restricted to the five file tools (no shell, no web search, no messages to
# other sessions, no MCP, no user settings), confined to the folder and the transcript's copies,
# and may not write git or settings files there without a person's approval, which a headless
# run never gets. The folder is the most a call can reach; the host refuses one that holds keys,
# settings or the code a run executes (native/workflows.ts `checkFolder`).
setopt err_exit no_unset pipe_fail
# Characters, not bytes, in the summary's length: the browser starts the host with no locale at all.
export LC_ALL=en_US.UTF-8

inbox=$RESCRIBE_RUN_DIR/recording
fail() {
  print -r -- "$*"
  exit 1
}

[[ -d $RESCRIBE_FOLDER ]] || fail "$RESCRIBE_FOLDER is not there any more; nothing was done"
print -r -- "[claude] $RESCRIBE_WORKFLOW: claude -p (restricted) in $RESCRIBE_FOLDER, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $RESCRIBE_FOLDER
# The prompt on stdin, not as an argument: one that starts with "-" (a list, front matter) would be
# taken for an option.
claude -p --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --add-dir $inbox --permission-mode acceptEdits --model opus --output-format stream-json --verbose <$RESCRIBE_PROMPT >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

# Its one line, for the notification and the row. Without one the work is done all the same.
summary=$(grep -m1 '[^[:space:]]' $inbox/summary 2>/dev/null | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true)
if [[ -n $summary ]]; then
  if ((${#summary} > 200)); then summary="${summary[1,199]}…"; fi
  print -r -- $summary >$RESCRIBE_RUN_DIR/summary.txt
  print -r -- "Done: $summary"
else
  print -r -- "Done in $RESCRIBE_FOLDER; Claude Code wrote no summary (see $RESCRIBE_RUN_DIR/trace.jsonl)"
fi
