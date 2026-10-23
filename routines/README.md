# Routines

What Rescribe can do with a recording once its transcript is in the folder. Each directory here is one routine, offered by name in the stop dialog and on the recording's row; the native host (`native/`) lists them and runs the one picked, outside the browser. See AGENTS/DNA/DECISIONS.md § Routines.

A routine is a directory `routines/<id>/` with:

- `routine.json`: `label` (the button), `description` (one line under it), `order` (smaller first, default 100), `timeoutMinutes` (default 60; the run is stopped after it).
- `run.sh`: executable. Each run gets a copy of the routine's directory (`$RESCRIBE_RUN_DIR/routine/`), and `run.sh` runs from there, with that directory as the working directory, so a pull cannot change a script under a run that is reading it. It gets:
  - `RESCRIBE_RECORDING_DIR`: the recording's directory, with `transcript.md`, `transcript.json`, `meta.json` and the video.
  - `RESCRIBE_RUN_DIR`: `~/.rescribe/runs/<runId>/`, this run's, for anything it keeps. Its output goes to `log.txt` there.
  - `RESCRIBE_RUN_ID`, `RESCRIBE_TITLE`.
  - `PATH` with `~/.local/bin` and Homebrew in front, and no `ANTHROPIC_API_KEY` (`claude` uses the subscription).

What was said on a call is untrusted: anyone on it can address an agent that reads it. A routine that runs Claude Code runs it `--restricted --strict-mcp-config`, never with permissions bypassed, and does anything that needs a shell or the network in `run.sh` itself (`native/routines.test.ts` checks every routine).

Exit 0 is done. The line the human reads (the notification, the row, the processing tab) is `$RESCRIBE_RUN_DIR/summary.txt` when the routine writes one, else the last line it printed; on a failure, always the last line printed.

The host runs routines from the clone it was installed from (`npm run install-host` in the primary clone), so a new or changed routine is live once it is merged and pulled there; no reload of the extension needed, unless the list in an open Rescribe tab should change (it reads the list when it loads).

## index-in-lawcel

Files the transcript as `lawcel-knowledge/meetings/transcripts/<date>-<names>.md`, writes the meeting note and updates the CRM, decisions, questions and reminders there, and pushes to `main`. `run.sh` makes a worktree of lawcel-knowledge under the run directory and copies `transcript.md` and `meta.json` into its `.rescribe/`; `claude -p --restricted` writes the markdown, following `prompt.md` and lawcel-knowledge's own CLAUDE.md, and hands back the name, a commit subject and a summary in `.rescribe/`; `run.sh` then files the transcript under that name, commits, rebases on `origin/main`, pushes, and counts the run as done only when its commit is on `origin/main`. The human's clone is then fast-forwarded when nothing is in the way. A failed run keeps its worktree and says where. `LAWCEL_KNOWLEDGE` overrides the repository's path.
