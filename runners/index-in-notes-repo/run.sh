#!/bin/zsh
# Index in a notes repo: the transcript into a git repository of notes, notes from it, pushed to
# main (runners/README.md). Started by native/supervise.ts with RESCRIBE_RECORDING_DIR,
# RESCRIBE_RUN_DIR, RESCRIBE_RUN_ID, RESCRIBE_FOLDER (the workflow's folder: the clone of the
# notes), RESCRIBE_WORKFLOW and RESCRIBE_PROMPT (the workflow's prompt, filled in). The last line
# it prints is what the human reads when it fails.
#
# The same split as Index in Lawcel, without the board. What was said on the call is not trusted:
# anyone on it can talk to the agent that reads it. So Claude Code runs restricted to the five file
# tools (no shell, no web, no MCP, no user settings; file tools confined to its working directory)
# in a worktree of its own, with the meeting's files copied into it, and only writes markdown. This
# script does the rest: the transcript into the place the agent chose, checked, the commit, the
# rebase and the push, and the check that it landed. The human's clone, which may be mid-edit, is
# only fast-forwarded at the end.
setopt err_exit no_unset pipe_fail
export LC_ALL=en_US.UTF-8

repo=$RESCRIBE_FOLDER
work=$RESCRIBE_RUN_DIR/notes
branch=rescribe/$RESCRIBE_RUN_ID
workflow=${RESCRIBE_WORKFLOW:-Index in a notes repo}

say() { print -r -- "[index-in-notes-repo] $*"; }
fail() {
  print -r -- "$*"
  exit 1
}
first_line() { [[ -s $1 ]] && head -1 $1 | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true; }
# A transcript's header: its title and the line with the date and time it started. Two transcripts
# with the same header are the same meeting, transcribed once or again.
header() { head -3 | tr -d '\r'; }

say "recording: $RESCRIBE_RECORDING_DIR"
git -C $repo rev-parse --git-dir >/dev/null 2>&1 || fail "$repo is not a git clone; nothing was indexed"
git -C $repo fetch --quiet origin main 2>&1 ||
  fail "git could not fetch main from $repo's origin; nothing was indexed"
git -C $repo worktree add --quiet -b $branch $work origin/main

# The agent's inbox and outbox, inside its working directory: the meeting in; where the transcript
# goes, the commit message and the summary out. Removed before the commit.
box=$work/.rescribe
mkdir -p $box
cp $RESCRIBE_RECORDING_DIR/transcript.md $RESCRIBE_RECORDING_DIR/meta.json $box/

say "claude -p (restricted) in $work, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $work
# The prompt on stdin, not as an argument: one that starts with "-" would be taken for an option.
claude -p --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --add-dir $RESCRIBE_RUN_DIR/recording --permission-mode acceptEdits --model opus --output-format stream-json --verbose <$RESCRIBE_PROMPT >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

# Where the transcript goes: a markdown file inside the repository, in no hidden folder, not an
# agent's instructions, and not another meeting's transcript. A place that is none of these stops
# the run before anything is pushed: the notes would link a transcript that is not there.
target=$(first_line $box/transcript-path)
target=${target#./}
[[ $target =~ '^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$' && /$target != */.* && $target != *//* &&
  ${target:t} != (CLAUDE.md|CLAUDE.local.md|AGENTS.md|GEMINI.md) ]] ||
  fail "Claude Code gave no usable place for the transcript (\"$target\"); the work is in $work"
[[ ! -d $target ]] || fail "$target is a folder, not a place for the transcript; the work is in $work"
if git cat-file -e "origin/main:$target" 2>/dev/null; then
  if [[ "$(git show "origin/main:$target" | header)" != "$(header <$box/transcript.md)" ]]; then
    fail "$target is another meeting's transcript; the work is in $work"
  fi
fi

problems=()
for entry in $box/*(DN); do
  if [[ ${entry:t} != (transcript.md|meta.json|transcript-path|commit-message|summary) ]]; then
    problems+=(".rescribe/${entry:t} was not part of the hand-over")
  fi
done

mkdir -p ${target:h}
cp $box/transcript.md $target
subject=$(first_line $box/commit-message)
summary=$(first_line $box/summary)
cp -R $box $RESCRIBE_RUN_DIR/handover
rm -rf $box

# A meeting indexed again may leave nothing to commit: its notes on origin/main are already its own.
git add -A
# What steers the human's later agents, which have a shell (CLAUDE.md, AGENTS.md, and hidden files:
# settings, hooks, commands), is not the call's to write: put back as it is on origin/main (the
# agent's version kept in the run's set-aside/) and named.
for touched in ${(0)"$(git diff --cached --name-only -z)"}; do
  if [[ /$touched == */.* || ${touched:t} == (CLAUDE.md|CLAUDE.local.md|AGENTS.md|GEMINI.md) ]]; then
    if [[ -f $touched ]]; then
      mkdir -p $RESCRIBE_RUN_DIR/set-aside/${touched:h}
      cp -p $touched $RESCRIBE_RUN_DIR/set-aside/$touched
    fi
    git reset --quiet HEAD -- $touched
    git checkout --quiet HEAD -- $touched 2>/dev/null || rm -f -- $touched
    problems+=("$touched was changed by the agent and left out")
  fi
done
# Anything new at the top of the repository is named: the notes have a structure, and a file outside
# it would otherwise be pushed without a word.
for added in ${(0)"$(git diff --cached --name-only --diff-filter=A -z)"}; do
  if ! git cat-file -e "origin/main:${added%%/*}" 2>/dev/null; then
    problems+=("$added is new at the top of ${repo:t}")
  fi
done
if git diff --cached --quiet; then
  pushed="Nothing new to push"
  say "${repo:t} already has everything from this meeting"
else
  git commit --quiet -m "${subject:-notes ${${target:t}%.md}}" -m "Indexed by Rescribe ($workflow, run $RESCRIBE_RUN_ID)."
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
  pushed="Pushed $(git log -1 --format='%h %s')"
fi

# The human's clone: fast-forwarded when it is on main and nothing in it is in the way.
if [[ $(git -C $repo symbolic-ref --quiet --short HEAD || true) == main ]]; then
  if git -C $repo merge --ff-only --quiet origin/main 2>/dev/null; then
    say "fast-forwarded $repo"
  else
    say "$repo not fast-forwarded (local changes in the way); a git pull there brings it"
  fi
fi

cd /
git -C $repo worktree remove --force $work
git -C $repo branch --quiet -D $branch

[[ -n $summary ]] &&
  print -r -- "$summary${problems:+ To look at: ${(j:; :)problems} (in $RESCRIBE_RUN_DIR/handover).}" >$RESCRIBE_RUN_DIR/summary.txt
print -r -- "$pushed${problems:+; to look at: ${(j:; :)problems}}"
