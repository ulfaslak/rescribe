#!/bin/zsh
# Index in Lawcel: the transcript into lawcel-knowledge, notes from it, synced with git, and the
# call's action items as cards on the founders' board (routines/README.md). Started by
# native/supervise.ts with RESCRIBE_RECORDING_DIR, RESCRIBE_RUN_DIR and RESCRIBE_RUN_ID. The last
# line it prints is what the human reads when it fails.
#
# What was said on the call is not trusted: anyone on it can talk to the agent that reads it. So
# Claude Code runs restricted to the five file tools (no shell, no web search, no messages to
# other sessions, no MCP, no user settings; file tools confined to its working directory) in a
# worktree of its own, with the meeting's files copied into it, and
# only writes markdown. This script does everything else: the board read for it beforehand, the
# transcript into place under the name the agent chose, the commit, the rebase and the push, the
# check that it landed, and the cards it wrote filed as issues. The human's clone, which may be
# mid-edit, is only fast-forwarded at the end.
setopt err_exit no_unset pipe_fail

repo=${LAWCEL_KNOWLEDGE:-$HOME/Documents/git/lawcel-knowledge}
# The board's cards are this repository's issues: its project
# (https://github.com/orgs/Lawcel/projects/2) adds a new one in Triage on its own.
github=Lawcel/lawcel-knowledge
max_cards=10
work=$RESCRIBE_RUN_DIR/lawcel-knowledge
branch=rescribe/$RESCRIBE_RUN_ID
here=${0:A:h}
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

say() { print -r -- "[index-in-lawcel] $*"; }
fail() {
  print -r -- "$*"
  exit 1
}
first_line() { [[ -s $1 ]] && head -1 $1 | tr -d '\r' || true; }

say "recording: $RESCRIBE_RECORDING_DIR"

# The board as it is, so the agent files nothing it already has, and who a card can go to. Read
# first: without gh nothing else is worth starting.
say "reading $github's issues"
gh issue list -R $github --state all --limit 1000 --json number,title,state,assignees,body,url \
  >$RESCRIBE_RUN_DIR/board.json || fail "gh could not read $github's issues (gh auth status); nothing was indexed"
gh api --paginate repos/$github/assignees --jq '.[].login' >$RESCRIBE_RUN_DIR/assignable ||
  fail "gh could not read who can be assigned in $github; nothing was indexed"
assignable=(${(f)"$(<$RESCRIBE_RUN_DIR/assignable)"})
: >$RESCRIBE_RUN_DIR/assignable.tsv
for login in $assignable; do
  gh api users/$login --jq '[.login, .name // ""] | @tsv' >>$RESCRIBE_RUN_DIR/assignable.tsv ||
    fail "gh could not read the GitHub user $login; nothing was indexed"
done

git -C $repo fetch --quiet origin main
git -C $repo worktree add --quiet -b $branch $work origin/main

# The agent's inbox and outbox, inside its working directory: the meeting and the board in; the
# name, the commit message, the summary and the cards out. Removed before the commit.
box=$work/.rescribe
mkdir -p $box
cp $RESCRIBE_RECORDING_DIR/transcript.md $RESCRIBE_RECORDING_DIR/meta.json $box/
cp $RESCRIBE_RUN_DIR/board.json $RESCRIBE_RUN_DIR/assignable.tsv $box/

say "claude -p (restricted) in $work, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $work
claude -p "$(<$here/prompt.md)" --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --permission-mode acceptEdits --model opus --output-format stream-json --verbose >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

name=$(first_line $box/name)
[[ $name =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)+$' ]] ||
  fail "Claude Code gave no usable name (\"$name\"); the work is in $work"
[[ -s meetings/notes/$name.md ]] || fail "No meetings/notes/$name.md was written; the work is in $work"

# The cards, checked before anything is pushed, so a call talked into a flood of them stops here,
# and kept in the run's directory with the line saying where each came from. Filed after the push.
cards=($box/cards/*(N/n))
(($#cards <= max_cards)) ||
  fail "Claude Code wrote $#cards cards, more than $max_cards; nothing was pushed; the work is in $work"
provenance="_From the call [$name](https://github.com/$github/blob/main/meetings/notes/$name.md). Filed by an agent (Rescribe, Index in Lawcel run $RESCRIBE_RUN_ID)._"
for card in $cards; do
  kept=$RESCRIBE_RUN_DIR/cards/${card:t}
  title=$(first_line $card/title)
  lines=$(grep -c . $card/title 2>/dev/null || true)
  [[ -n $title && ${#title} -le 120 && $lines == 1 ]] ||
    fail "Card ${card:t} has no one-line title of at most 120 characters; nothing was pushed; the work is in $work"
  grep -q '[^[:space:]]' $card/body.md 2>/dev/null ||
    fail "Card ${card:t} has no body.md; nothing was pushed; the work is in $work"
  mkdir -p $kept
  print -r -- $title >$kept/title
  print -r -- "$(<$card/body.md)"$'\n\n'"$provenance" >$kept/issue.md
  : >$kept/assignees
  if [[ -f $card/assignees ]]; then
    for login in ${(f)"$(<$card/assignees)"}; do
      login=${${login//[[:space:]]/}#@}
      [[ -n $login ]] || continue
      if ((${assignable[(Ie)$login]})); then
        print -r -- $login >>$kept/assignees
      else
        say "card ${card:t}: $login cannot be assigned in $github; left out"
      fi
    done
  fi
done

cp $box/transcript.md meetings/transcripts/$name.md
subject=$(first_line $box/commit-message)
summary=$(first_line $box/summary)
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

# The cards, now that the note they link to is on origin/main.
filed=()
for card in $RESCRIBE_RUN_DIR/cards/*(N/n); do
  title=$(<$card/title)
  who=${(j:,:)${(f)"$(<$card/assignees)"}}
  url=$(gh issue create -R $github --title $title --body-file $card/issue.md ${who:+--assignee=$who}) ||
    fail "Pushed $commit, but filing \"$title\" on the board failed${filed:+ (filed ${(j:, :)filed})}; the cards are in $RESCRIBE_RUN_DIR/cards"
  url=${url##*$'\n'}
  filed+=("#${url:t}")
  say "filed $url: $title"
done

[[ -n $summary ]] && print -r -- "$summary${filed:+ Cards: ${(j:, :)filed}.}" >$RESCRIBE_RUN_DIR/summary.txt
print -r -- "Pushed $commit${filed:+; filed ${(j:, :)filed}}"
