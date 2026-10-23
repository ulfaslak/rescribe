# Routines

What Rescribe can do with a recording once its transcript is in the folder. Each directory here is one routine, offered by name in the stop dialog and on the recording's row; the native host (`native/`) lists them and runs the one picked, outside the browser. See AGENTS/DNA/DECISIONS.md § Routines.

A routine is a directory `routines/<id>/` with:

- `routine.json`: `label` (the button), `description` (one line under it), `order` (smaller first, default 100), `timeoutMinutes` (default 60; the run is stopped after it).
- `run.sh`: executable. It runs with its own directory as the working directory and gets:
  - `RESCRIBE_RECORDING_DIR`: the recording's directory, with `transcript.md`, `transcript.json`, `meta.json` and the video.
  - `RESCRIBE_RUN_DIR`: `~/.rescribe/runs/<runId>/`, this run's, for anything it keeps. Its output goes to `log.txt` there.
  - `RESCRIBE_RUN_ID`, `RESCRIBE_TITLE`.
  - `PATH` with `~/.local/bin` and Homebrew in front, and no `ANTHROPIC_API_KEY` (`claude` uses the subscription).

Exit 0 is done. The line the human reads (the notification, the row, the processing tab) is `$RESCRIBE_RUN_DIR/summary.txt` when the routine writes one, else the last line it printed; on a failure, always the last line printed.

The host runs routines from the clone it was installed from (`npm run install-host` in the primary clone), so a new or changed routine is live once it is merged and pulled there; no reload of the extension needed, unless the list in an open Rescribe tab should change (it reads the list when it loads).

## index-in-lawcel

Copies the transcript into `lawcel-knowledge/meetings/transcripts/<date>-<names>.md`, writes the meeting note and updates the CRM, decisions, questions and reminders there, and pushes to `main`. `claude -p` does it, following `prompt.md` and lawcel-knowledge's own CLAUDE.md, in a worktree under the run directory; the run counts as done only when its commit is on `origin/main`. The human's clone is then fast-forwarded when nothing is in the way. A failed run keeps its worktree and says where. `LAWCEL_KNOWLEDGE` overrides the repository's path.
