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
# settings or the code a run executes (native/workflows.ts `checkFolder`). In it, what steers or
# runs the human's later tools is not the call's to write either: hidden files and agent
# instructions (CLAUDE.md, AGENTS.md, which a later Claude Code with a shell would obey) are
# kept before Claude Code starts and put back after, and new ones are set aside.
setopt err_exit no_unset pipe_fail
# Characters, not bytes, in the summary's length: the browser starts the host with no locale at all.
export LC_ALL=en_US.UTF-8

inbox=$RESCRIBE_RUN_DIR/recording
kept=$RESCRIBE_RUN_DIR/steering
fail() {
  print -r -- "$*"
  exit 1
}
# Every hidden file and agent instruction under the current directory, NUL-separated; .git is
# guarded by Claude Code itself, node_modules is nobody's notes.
steering() {
  find . \( -name .git -o -name node_modules \) -prune -o -type f \
    \( -path '*/.*' -o -name CLAUDE.md -o -name CLAUDE.local.md -o -name AGENTS.md -o -name GEMINI.md \) -print0
}

[[ -d $RESCRIBE_FOLDER ]] || fail "$RESCRIBE_FOLDER is not there any more; nothing was done"
print -r -- "[claude] $RESCRIBE_WORKFLOW: claude -p (restricted) in $RESCRIBE_FOLDER, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $RESCRIBE_FOLDER
before=(${(0)"$(steering)"})
if (($#before)); then
  print -rN -- $before | tar -cf $RESCRIBE_RUN_DIR/steering.tar --null -T - ||
    fail "Could not keep a copy of the folder's hidden files and agent instructions; nothing was done"
fi
# The prompt on stdin, not as an argument: one that starts with "-" (a list, front matter) would be
# taken for an option.
claude -p --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --add-dir $inbox --permission-mode acceptEdits --model opus --output-format stream-json --verbose <$RESCRIBE_PROMPT >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

# What steers later tools, as it was: changed or deleted ones put back, new ones set aside.
put_back=()
set_aside=()
mkdir -p $kept
if (($#before)); then tar -xf $RESCRIBE_RUN_DIR/steering.tar -C $kept; fi
for f in $before; do
  if [[ ! -f $f ]] || ! cmp -s $kept/$f $f; then
    mkdir -p ${f:h}
    cp -p $kept/$f $f
    put_back+=(${f#./})
  fi
done
for f in ${(0)"$(steering)"}; do
  if ((! ${before[(Ie)$f]})); then
    mkdir -p $RESCRIBE_RUN_DIR/set-aside/${f:h}
    mv $f $RESCRIBE_RUN_DIR/set-aside/$f
    set_aside+=(${f#./})
  fi
done
left_alone="${put_back:+ Put back as they were: ${(j:, :)put_back}.}${set_aside:+ Set aside in $RESCRIBE_RUN_DIR/set-aside: ${(j:, :)set_aside}.}"
if [[ -n $left_alone ]]; then print -r -- "[claude]$left_alone"; fi

# Its one line, for the notification and the row. Without one the work is done all the same.
summary=$(grep -m1 '[^[:space:]]' $inbox/summary 2>/dev/null | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true)
if [[ -n $summary ]]; then
  if ((${#summary} > 200)); then summary="${summary[1,199]}…"; fi
  print -r -- "$summary$left_alone" >$RESCRIBE_RUN_DIR/summary.txt
  print -r -- "Done: $summary$left_alone"
else
  print -r -- "Done in $RESCRIBE_FOLDER; Claude Code wrote no summary (see $RESCRIBE_RUN_DIR/trace.jsonl).$left_alone"
fi
