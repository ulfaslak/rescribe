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
# Characters, not bytes, in a title's length: the browser starts the host with no locale at all.
export LC_ALL=en_US.UTF-8

repo=${LAWCEL_KNOWLEDGE:-$HOME/Documents/git/lawcel-knowledge}
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

# The board's cards are issues of the GitHub repository the clone is, as gh resolves its remote (an
# SSH alias, a user in the URL and insteadOf included), so a clone pointed anywhere else never files
# on the founders' board. Its project (https://github.com/orgs/Lawcel/projects/2) adds a new issue
# in Triage on its own.
github=$(cd $repo && gh repo view --json nameWithOwner --jq .nameWithOwner) ||
  fail "gh could not tell which GitHub repository $repo is (its origin; gh auth status); nothing was indexed"

# The board as it is, so the agent can leave out what it already has, and who a card can go to.
# Read first: without gh nothing else is worth starting. One issue to a line or two (a long board
# on one line would be more than the agent's Read takes), with the call an agent filed it from.
say "reading $github's issues"
gh issue list -R $github --state all --limit 1000 --json number,title,state,assignees,body --jq '.[]
  | "#\(.number) \(.state) \(.title)"
  + (if (.assignees | length) > 0 then " (assigned: \([.assignees[].login] | join(", ")))" else "" end)
  + ([.body | scan("From the call \\[([^\\]]+)\\]")] | if length > 0 then " (filed from the call \(.[0][0]))" else "" end)
  + "\n    " + (.body | gsub("_From the call [^\n]*"; "") | gsub("\\s+"; " ") | gsub("^ | $"; "") | .[0:300])' \
  >$RESCRIBE_RUN_DIR/board.md || fail "gh could not read $github's issues (gh auth status); nothing was indexed"
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
cp $RESCRIBE_RUN_DIR/board.md $RESCRIBE_RUN_DIR/assignable.tsv $box/

say "claude -p (restricted) in $work, trace in $RESCRIBE_RUN_DIR/trace.jsonl"
cd $work
claude -p "$(<$here/prompt.md)" --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep \
  --permission-mode acceptEdits --model opus --output-format stream-json --verbose >$RESCRIBE_RUN_DIR/trace.jsonl ||
  fail "Claude Code exited with an error; see $RESCRIBE_RUN_DIR/trace.jsonl"

name=$(first_line $box/name)
[[ $name =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)+$' ]] ||
  fail "Claude Code gave no usable name (\"$name\"); the work is in $work"
[[ -s meetings/notes/$name.md ]] || fail "No meetings/notes/$name.md was written; the work is in $work"

# The hand-over, checked before anything is pushed: nothing in .rescribe/ but what the prompt asks
# for (a card written anywhere else would be lost without a word), at most ten cards, each with a
# one-line title, a short body that hides nothing, and assignees who can be assigned. A call talked
# into a flood of cards stops here. The cards are kept in the run's directory with the line saying
# where each came from, a mention in them made inert, and are filed after the push.
for entry in $box/*(DN); do
  [[ ${entry:t} == (transcript.md|meta.json|board.md|assignable.tsv|name|commit-message|summary|cards) ]] ||
    fail "Claude Code wrote .rescribe/${entry:t}, which is not part of the hand-over; nothing was pushed; the work is in $work"
done
[[ ! -e $box/cards || -d $box/cards ]] ||
  fail "Claude Code wrote .rescribe/cards as a file, not a directory of cards; nothing was pushed; the work is in $work"
for entry in $box/cards/*(DN); do
  [[ -d $entry ]] ||
    fail "Claude Code wrote .rescribe/cards/${entry:t}, which is not a card's directory; nothing was pushed; the work is in $work"
done
cards=($box/cards/*(N/n))
(($#cards <= max_cards)) ||
  fail "Claude Code wrote $#cards cards, more than $max_cards; nothing was pushed; the work is in $work"
provenance="_From the call [$name](https://github.com/$github/blob/main/meetings/notes/$name.md). Filed by an agent (Rescribe, Index in Lawcel run $RESCRIBE_RUN_ID)._"
for card in $cards; do
  bad() { fail "Card ${card:t} $1; nothing was pushed; the work is in $work"; }
  title=$(first_line $card/title | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  lines=$(grep -c . $card/title 2>/dev/null || true)
  [[ -n $title && ${#title} -le 120 && $lines == 1 ]] || bad "has no one-line title of at most 120 characters"
  [[ -f $card/body.md ]] || bad "has no body.md"
  body=$(<$card/body.md)
  [[ $body == *[^[:space:]]* ]] || bad "has no body.md"
  ((${#body} <= 2000)) || bad "has a body.md longer than 2000 characters"
  # HTML or a code fence could hide text, or swallow the line saying where the card came from.
  ! grep -qE '<[[:alpha:]!?/]' $card/body.md || bad "has HTML in body.md"
  ! grep -qE '^[[:space:]]*(```|~~~)' $card/body.md || bad "has a code fence in body.md"
  # A mention notifies whoever it names; the assignees are who should hear of a card. Only a letter
  # or a digit before the @ (an address) keeps it from being one.
  body=$(print -r -- $body | sed -E 's/(^|[^[:alnum:]])@([[:alnum:]-]+)/\1`@\2`/g')
  kept=$RESCRIBE_RUN_DIR/cards/${card:t}
  mkdir -p $kept
  print -r -- $title >$kept/title
  print -r -- $body$'\n\n'$provenance >$kept/issue.md
  : >$kept/assignees
  if [[ -f $card/assignees ]]; then
    for login in ${(f)"$(<$card/assignees)"}; do
      login=${${login//[[:space:]]/}#@}
      [[ -n $login ]] || continue
      match=
      for a in $assignable; do
        if [[ ${(L)a} == "${(L)login}" ]]; then match=$a; fi
      done
      if [[ -n $match ]]; then
        print -r -- $match >>$kept/assignees
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

# A meeting indexed again may leave nothing to commit: its notes on origin/main are already its own.
git add -A
# Nothing new at the top of the repository: a card or anything else the agent wrote outside the
# folders lawcel-knowledge has would be pushed, and lost to the board, without a word.
for added in ${(0)"$(git diff --cached --name-only --diff-filter=A -z)"}; do
  git cat-file -e "origin/main:${added%%/*}" 2>/dev/null ||
    fail "Claude Code wrote $added, outside what lawcel-knowledge has at its top level; nothing was pushed; the work is in $work"
done
if git diff --cached --quiet; then
  pushed="Nothing new to push"
  say "lawcel-knowledge already has everything from this meeting"
else
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
  pushed="Pushed $(git log -1 --format='%h %s')"
fi

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

# The cards, now that the note they link to is on origin/main. The board read again first: a card
# whose title is that of an open issue, or of one filed from this call (a run that filed it and then
# failed, an overlapping run, the meeting indexed again), is left out, whatever the agent made of it.
gh issue list -R $github --state all --limit 1000 --json number,title,state,body \
  --jq ".[] | select(.state == \"OPEN\" or (.body | contains(\"/meetings/notes/$name.md)\"))) | \"\(.number)\t\(.title)\"" \
  >$RESCRIBE_RUN_DIR/on-board.tsv ||
  fail "$pushed, but gh could not read $github's issues to file the cards; they are in $RESCRIBE_RUN_DIR/cards"
on_board=(${(f)"$(<$RESCRIBE_RUN_DIR/on-board.tsv)"})
filed=()
skipped=()
for card in $RESCRIBE_RUN_DIR/cards/*(N/n); do
  title=$(<$card/title)
  already=
  for issue in $on_board; do
    if [[ ${(L)issue#*$'\t'} == "${(L)title}" ]]; then already=${issue%%$'\t'*}; fi
  done
  if [[ -n $already ]]; then
    say "card ${card:t}: \"$title\" is on the board already (#$already); left out"
    skipped+=("#$already")
    continue
  fi
  who=${(j:,:)${(f)"$(<$card/assignees)"}}
  url=$(gh issue create -R $github --title $title --body-file $card/issue.md ${who:+--assignee=$who}) ||
    fail "$pushed, but filing \"$title\" on the board failed${filed:+ (filed ${(j:, :)filed})}; the cards are in $RESCRIBE_RUN_DIR/cards"
  url=${url##*$'\n'}
  filed+=("#${url:t}")
  on_board+=("${url:t}"$'\t'"$title")
  say "filed $url: $title"
done

# Cards left out are named too, so a call's action item that matched an older card is not lost from view.
cards_line="${filed:+ Cards: ${(j:, :)filed}.}${skipped:+ Already on the board: ${(j:, :)skipped}.}"
[[ -n $summary ]] && print -r -- "$summary$cards_line" >$RESCRIBE_RUN_DIR/summary.txt
print -r -- "$pushed${filed:+; filed ${(j:, :)filed}}${skipped:+; already on the board: ${(j:, :)skipped}}"
