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

# The board's cards are issues of the GitHub repository the notes are pushed to: origin's push URL,
# git's rewrites applied, as gh reads it (an SSH alias for github.com resolved the way ssh would), so
# a clone pointed anywhere else never files on the founders' board, and one redirected to a local
# copy files nowhere. Its project (https://github.com/orgs/Lawcel/projects/2) adds a new issue in
# Triage on its own.
push_url=$(git -C $repo remote get-url --push origin 2>/dev/null || true)
if [[ $push_url =~ '^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+):([^/].*)$' ]]; then
  host=$(ssh -G $match[2] 2>/dev/null | awk '$1 == "hostname" { print $2; exit }' || true)
  if [[ -n $host ]]; then push_url=$match[1]$host:$match[3]; fi
fi
[[ -n $push_url ]] && github=$(gh repo view $push_url --json nameWithOwner --jq .nameWithOwner) ||
  fail "gh could not tell which GitHub repository $repo pushes to (\"$push_url\"; gh auth status); nothing was indexed"

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

# The hand-over. Nothing in it holds back the call's notes: what the script cannot file as it is, it
# leaves out and names in the summary, and all of it stays in the run's directory (handover/). What
# a call can do with a card is bounded: at most ten (more files none), a title of one line, a body of
# at most 2000 characters in which HTML, a code fence and a mention are inert, and assignees who can
# be assigned there. Each card is kept with the line saying where it came from, and filed after the push.
problems=()
for entry in $box/*(DN); do
  if [[ ${entry:t} != (transcript.md|meta.json|board.md|assignable.tsv|name|commit-message|summary|cards) ]]; then
    problems+=(".rescribe/${entry:t} was not part of the hand-over")
  fi
done
if [[ -e $box/cards && ! -d $box/cards ]]; then problems+=(".rescribe/cards was a file"); fi
for entry in $box/cards/*(DN); do
  if [[ ! -d $entry ]]; then problems+=(".rescribe/cards/${entry:t} was not a card's directory"); fi
done
cards=($box/cards/*(N/n))
if (($#cards > max_cards)); then
  problems+=("$#cards cards were written, more than $max_cards, so none was filed")
  cards=()
fi
provenance="_From the call [$name](https://github.com/$github/blob/main/meetings/notes/$name.md). Filed by an agent (Rescribe, Index in Lawcel run $RESCRIBE_RUN_ID)._"
# HTML (a < before a tag's first character), a code fence and a mention made inert: an escaped <, an
# escaped fence, a zero-width space after the @. Only a letter or a digit before an @ (an address)
# keeps it from being a mention. An autolink in <> first becomes the bare URL or address, which
# GitHub links all the same.
inert=(-e 's/<((https?:\/\/|mailto:)[^[:space:]<>]+)>/\1/g' -e 's/<([^[:space:]<>@]+@[^[:space:]<>]+)>/\1/g'
  -e 's/<([[:alpha:]!?\/])/\&lt;\1/g' -e 's/^([[:space:]]*)(```|~~~)/\1\\\2/'
  -e "s/(^|[^[:alnum:]])@([[:alnum:]-])/\\1@"$'\u200b'"\\2/g")
for card in $cards; do
  # The first line that is not blank, trimmed, at most 120 characters.
  title=$(grep -m1 '[^[:space:]]' $card/title 2>/dev/null | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true)
  if ((${#title} > 120)); then title="${title[1,119]}…"; fi
  body=
  if [[ -f $card/body.md ]]; then body=$(<$card/body.md); fi
  if [[ -z $title ]]; then
    problems+=("card ${card:t} had no title")
    continue
  fi
  if [[ $body != *[^[:space:]]* ]]; then
    problems+=("card ${card:t} had no body")
    continue
  fi
  if ((${#body} > 2000)); then body="${body[1,1999]}…"; fi
  body=$(print -r -- $body | sed -E $inert)
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
cp -R $box $RESCRIBE_RUN_DIR/handover
rm -rf $box

# A meeting indexed again may leave nothing to commit: its notes on origin/main are already its own.
git add -A
# Anything new at the top of the repository is named: a card written there instead of in .rescribe/
# would otherwise be pushed, and lost to the board, without a word.
for added in ${(0)"$(git diff --cached --name-only --diff-filter=A -z)"}; do
  if ! git cat-file -e "origin/main:${added%%/*}" 2>/dev/null; then
    problems+=("$added is new at the top of lawcel-knowledge")
  fi
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

# Cards left out are named too, so a call's action item that matched an older card, or that the
# script could not file, is not lost from view.
cards_line="${filed:+ Cards: ${(j:, :)filed}.}${skipped:+ Already on the board: ${(j:, :)skipped}.}"
cards_line+="${problems:+ To look at: ${(j:; :)problems} (in $RESCRIBE_RUN_DIR/handover).}"
[[ -n $summary ]] && print -r -- "$summary$cards_line" >$RESCRIBE_RUN_DIR/summary.txt
print -r -- "$pushed${filed:+; filed ${(j:, :)filed}}${skipped:+; already on the board: ${(j:, :)skipped}}${problems:+; to look at: ${(j:; :)problems}}"
