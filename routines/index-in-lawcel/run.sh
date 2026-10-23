#!/bin/zsh
# Index in Lawcel: the transcript into lawcel-knowledge, notes from it, synced with git
# (routines/README.md). Claude Code does the work headless in a worktree of its own, so the
# human's clone, which may be mid-edit, is not touched until the end, and then only fast-forwarded.
# Started by native/supervise.ts with RESCRIBE_RECORDING_DIR, RESCRIBE_RUN_DIR and RESCRIBE_RUN_ID.
# The last line it prints is what the human reads when it fails; on success, summary.txt.
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

say "recording: $RESCRIBE_RECORDING_DIR"
git -C $repo fetch --quiet origin main
git -C $repo worktree add --quiet -b $branch $work origin/main
git -C $work branch --quiet --set-upstream-to=origin/main
base=$(git -C $work rev-parse HEAD)

prompt=$(<$here/prompt.md)
prompt=${prompt//'{{RECORDING_DIR}}'/$RESCRIBE_RECORDING_DIR}
prompt=${prompt//'{{SUMMARY_FILE}}'/$RESCRIBE_RUN_DIR/summary.txt}

say "claude -p in $work, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $work
claude -p "$prompt" --permission-mode bypassPermissions --output-format stream-json --verbose \
  >$RESCRIBE_RUN_DIR/trace.jsonl || fail "Claude Code exited with an error; the work is in $work"

# It counts only when the commit is on origin/main and nothing was left behind.
git fetch --quiet origin main
[[ -z $(git status --porcelain) ]] || fail "Uncommitted changes left behind in $work"
[[ $(git rev-parse HEAD) != $base ]] || fail "Nothing was committed; see $RESCRIBE_RUN_DIR/trace.jsonl"
git merge-base --is-ancestor HEAD origin/main || fail "Not pushed to origin/main; the work is in $work"
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
