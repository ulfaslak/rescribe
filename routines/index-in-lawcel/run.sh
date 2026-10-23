#!/bin/zsh
# Index in Lawcel: the transcript into lawcel-knowledge, notes from it, synced with git
# (routines/README.md). Started by native/supervise.ts with RESCRIBE_RECORDING_DIR, RESCRIBE_RUN_DIR
# and RESCRIBE_RUN_ID. The last line it prints is what the human reads when it fails.
#
# What was said on the call is not trusted: anyone on it can talk to the agent that reads it. So
# Claude Code runs restricted to the five file tools (no shell, no web search, no messages to
# other sessions, no MCP, no user settings; file tools confined to its working directory) in a
# worktree of its own, with the meeting's files copied into it, and
# only writes markdown. This script does everything else: the transcript into place under the
# name the agent chose, the commit, the rebase and the push, and the check that it landed. The
# human's clone, which may be mid-edit, is only fast-forwarded at the end.
setopt err_exit no_unset pipe_fail

repo=${LAWCEL_KNOWLEDGE:-$HOME/Documents/git/lawcel-knowledge}
work=$RESCRIBE_RUN_DIR/lawcel-knowledge
branch=rescribe/$RESCRIBE_RUN_ID
here=${0:A:h}

say() { print -r -- "[index-in-lawcel] $*"; }
fail() {
  print -r -- "$*"
  exit 1
}
first_line() { [[ -s $1 ]] && head -1 $1 | tr -d '\r' || true; }

say "recording: $RESCRIBE_RECORDING_DIR"
git -C $repo fetch --quiet origin main
git -C $repo worktree add --quiet -b $branch $work origin/main

# The agent's inbox and outbox, inside its working directory: the meeting in; the name, the
# commit message and the summary out. Removed before the commit.
box=$work/.rescribe
mkdir -p $box
cp $RESCRIBE_RECORDING_DIR/transcript.md $RESCRIBE_RECORDING_DIR/meta.json $box/

say "claude -p (restricted) in $work, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $work
claude -p "$(<$here/prompt.md)" --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --permission-mode acceptEdits --model opus --output-format stream-json --verbose >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

name=$(first_line $box/name)
[[ $name =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)+$' ]] ||
  fail "Claude Code gave no usable name (\"$name\"); the work is in $work"
[[ -s meetings/notes/$name.md ]] || fail "No meetings/notes/$name.md was written; the work is in $work"
cp $box/transcript.md meetings/transcripts/$name.md
subject=$(first_line $box/commit-message)
summary=$(first_line $box/summary)
[[ -n $summary ]] && print -r -- $summary >$RESCRIBE_RUN_DIR/summary.txt
rm -rf $box

git add -A
git commit --quiet -m "${subject:-notes $name}" -m "Indexed by Rescribe (Index in Lawcel, run $RESCRIBE_RUN_ID)."
for attempt in 1 2 3; do
  if ! git pull --quiet --rebase origin main; then
    git rebase --abort 2>/dev/null || true
    fail "Rebasing on origin/main conflicted; the commit is on $branch in $work"
  fi
  git push --quiet origin HEAD:main && break
  ((attempt < 3)) || fail "The push to origin/main was refused three times; the commit is on $branch in $work"
done
git fetch --quiet origin main
git merge-base --is-ancestor HEAD origin/main || fail "The commit is not on origin/main; it is on $branch in $work"
commit=$(git log -1 --format='%h %s')

# The human's clone: fast-forwarded when it is on main and nothing in it is in the way.
if [[ $(git -C $repo symbolic-ref --quiet --short HEAD || true) == main ]]; then
  if git -C $repo merge --ff-only --quiet origin/main; then
    say "fast-forwarded $repo"
  else
    say "$repo not fast-forwarded (local changes in the way); a git pull there brings it"
  fi
fi

cd /
git -C $repo worktree remove --force $work
git -C $repo branch --quiet -D $branch
print -r -- "Pushed $commit"
