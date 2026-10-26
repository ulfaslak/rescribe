# Routines

What Rescribe can do with a recording once its transcript is in the folder. Each directory here is one routine, offered by name in the stop dialog and on the recording's row; the native host (`native/`) lists them and runs the one picked, outside the browser. See AGENTS/DNA/DECISIONS.md § Routines.

A routine is a directory `routines/<id>/` with:

- `routine.json`: `label` (the button), `description` (one line under it), `order` (smaller first, default 100), `timeoutMinutes` (default 60; the run is stopped after it).
- `run.sh`: executable. Each run gets a copy of the routine's directory (`$RESCRIBE_RUN_DIR/routine/`), and `run.sh` runs from there, with that directory as the working directory, so a pull cannot change a script under a run that is reading it. It gets:
  - `RESCRIBE_RECORDING_DIR`: the recording's directory, with `transcript.md`, `transcript.json`, `meta.json` and the video.
  - `RESCRIBE_RUN_DIR`: `~/.rescribe/runs/<runId>/`, this run's, for anything it keeps. Its output goes to `log.txt` there.
  - `RESCRIBE_RUN_ID`, `RESCRIBE_TITLE`.
  - `PATH` with `~/.local/bin` and Homebrew in front, and no `ANTHROPIC_API_KEY` (`claude` uses the subscription).

What was said on a call is untrusted: anyone on it can address an agent that reads it. A routine that runs Claude Code runs it `--restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep`, never with permissions bypassed, and does anything that needs a shell or the network in `run.sh` itself (`native/routines.test.ts` checks every routine).

Exit 0 is done. The line the human reads (the notification, the row, the processing tab) is `$RESCRIBE_RUN_DIR/summary.txt` when the routine writes one, else the last line it printed; on a failure, always the last line printed.

The host runs routines from the clone it was installed from (`npm run install-host` in the primary clone), so a new or changed routine is live once it is merged and pulled there; no reload of the extension needed, unless the list in an open Rescribe tab should change (it reads the list when it loads).

## index-in-lawcel

Files the transcript as `lawcel-knowledge/meetings/transcripts/<date>-<names>.md`, writes the meeting note and updates the CRM, decisions, questions and reminders there, pushes to `main`, and files the call's action items as cards on the founders' board ([Project management](https://github.com/orgs/Lawcel/projects/2)).

- `run.sh` first reads the board with `gh`: every issue in the GitHub repository `gh repo view` takes the clone for (`Lawcel/lawcel-knowledge`), one or two lines each, and who can be assigned there. A clone gh does not take for a GitHub repository, or no `gh`, stops it before anything else.
- It makes a worktree of lawcel-knowledge under the run directory and copies `transcript.md`, `meta.json` and the board into its `.rescribe/`.
- `claude -p --restricted` writes the markdown, following `prompt.md` and lawcel-knowledge's own CLAUDE.md, and hands back the name, a commit subject, a summary and the cards (`.rescribe/cards/<n>/`: `title`, `body.md`, `assignees`).
- `run.sh` checks the hand-over: nothing in `.rescribe/` it does not expect, at most ten cards, each with a one-line title and a body of plain markdown (at most 2000 characters, no HTML, no code fence), and nothing added at the top of lawcel-knowledge that is not there already; a mention is made inert and an assignee who cannot be assigned is left out. Then it files the transcript under the name, commits, rebases on `origin/main` and pushes. The run counts as pushed only when its commit is on `origin/main`, and a meeting indexed again that changes nothing commits nothing and goes on; the human's clone is then fast-forwarded when nothing is in the way.
- Last, it reads the board again and files each card whose title is neither open there nor already filed from this call as an issue in `Lawcel/lawcel-knowledge` (the board adds it in Triage), ending in a line that links the meeting's note and says an agent filed it. The summary ends with the cards' numbers, and the numbers of those it left out as already on the board.

A run that fails before the push keeps its worktree and says where; one that fails while filing says which cards it filed, and keeps the cards in the run directory. `LAWCEL_KNOWLEDGE` overrides the clone's path, and the cards follow that clone's remote.

It needs, on the machine that runs it: `claude` logged in on the subscription; lawcel-knowledge cloned at `~/Documents/git/lawcel-knowledge` (the browser starts the host without a shell profile, so `LAWCEL_KNOWLEDGE` set there does not reach it) with a push that never prompts; and `gh` logged in (`gh auth login`) as someone who can create issues in `Lawcel/lawcel-knowledge`.
