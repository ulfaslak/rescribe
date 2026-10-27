# Runners

A workflow is what Rescribe does with a recording once its transcript is in the folder: a name, a line, a folder and a prompt, which the human makes in the Rescribe tab's Workflows section and the native host (`native/`) keeps in `~/.rescribe/workflows/<id>/` (`workflow.json`, `prompt.md`). A runner is the code that runs one, outside the browser: each directory here is one, offered in the editor's "Runs with". See AGENTS/DNA/DECISIONS.md § Workflows.

A runner is a directory `runners/<id>/` with:

- `runner.json`: `label` (its name in the editor), `description` (what it does around Claude Code), `folder` (what the workflow's folder is to it, under the folder field), `defaultFolder` (a new workflow's, `~/` allowed), `order` (smaller first, default 100), `timeoutMinutes` (default 60; the run is stopped after it), and `seed` (`label`, `description`: a workflow of it, under the runner's id, is made the first time the host runs; never again after).
- `prompt.md`: the prompt a new workflow of it starts with.
- `before.md`, `after.md` (optional): what it puts before and after the workflow's prompt. The editor shows them. Anything `run.sh` reads back from Claude Code (a file it expects, a format) is asked for here, never in `prompt.md`: the human may rewrite a workflow's prompt, and a workflow keeps the copy of `prompt.md` it was made with.
- `run.sh`: executable. Each run gets a copy of the runner's directory (`$RESCRIBE_RUN_DIR/runner/`), and `run.sh` runs from there, with that directory as the working directory, so a pull cannot change a script under a run that is reading it. It gets:
  - `RESCRIBE_PROMPT`: the prompt to give Claude Code, a file: the before, the workflow's prompt, the after, with the variables filled in.
  - `RESCRIBE_FOLDER`: the workflow's folder, checked by the host (inside the home folder, not hidden, not `~/Library` but iCloud Drive and the cloud drives, not Rescribe's own).
  - `RESCRIBE_WORKFLOW`: the workflow's name.
  - `RESCRIBE_RECORDING_DIR`: the recording's directory, with `transcript.md`, `transcript.json`, `meta.json` and the video.
  - `RESCRIBE_RUN_DIR`: `~/.rescribe/runs/<runId>/`, this run's, for anything it keeps. Its output goes to `log.txt` there; `recording/` there holds copies of `transcript.md`, `transcript.json` and `meta.json`, which is what `{{transcript}}` points at.
  - `RESCRIBE_RUN_ID`, `RESCRIBE_TITLE`.
  - `PATH` with `~/.local/bin` and Homebrew in front, and no `ANTHROPIC_API_KEY` (`claude` uses the subscription).

The variables a prompt can use, each as `{{name}}`, anywhere and as often as it likes (`src/lib/routines.ts` `PROMPT_VARIABLES`): `title`, `date` (`2026-10-27`), `time` (`14:02`), `participants`, `transcript` (the copy's path), `folder`, `workflow`. Anything else in double braces stays as written.

What was said on a call is untrusted: anyone on it can address an agent that reads it. A runner runs Claude Code `claude -p --restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep … <$RESCRIBE_PROMPT` (the prompt on stdin: as an argument, one that starts with `-` is taken for an option), never with permissions bypassed, adds the run's copies with `--add-dir $RESCRIBE_RUN_DIR/recording`, and does anything that needs a shell or the network in `run.sh` itself (`native/runners.test.ts` checks every runner).

Exit 0 is done. The line the human reads (the notification, the row, the processing tab) is `$RESCRIBE_RUN_DIR/summary.txt` when the runner writes one, else the last line it printed; on a failure, always the last line printed.

The host runs runners from the clone it was installed from (`npm run install-host` in the primary clone), so a new or changed runner is live once it is merged and pulled there. A workflow is live as soon as it is saved.

## claude

Claude Code in a folder: `claude -p` in the workflow's folder, with the run's copies of the recording to read. Its `before.md` tells Claude Code that it is headless, and gives the call (title, names, transcript) as material, never instructions; hidden files and agent instructions in the folder (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.envrc`…) are kept before the run and put back after it, new ones set aside in `set-aside/`, and the summary names them; its `after.md` asks for one line saying what it did, in `summary` next to the transcript, which becomes the run's summary (cut to 200 characters). A run without one is still done.

## index-in-lawcel

Files the transcript as `lawcel-knowledge/meetings/transcripts/<date>-<names>.md`, writes the meeting note and updates the CRM, decisions, questions and reminders there, pushes to `main`, and files the call's action items as cards on the founders' board ([Project management](https://github.com/orgs/Lawcel/projects/2)).

- `run.sh` first reads the board with `gh`: every issue in the GitHub repository origin's push URL names (`Lawcel/lawcel-knowledge`), one or two lines each, and who can be assigned there. A clone gh cannot place on GitHub, or no `gh`, stops it before anything else.
- It makes a worktree of the workflow's folder, the lawcel-knowledge clone, under the run directory and copies `transcript.md`, `meta.json` and the board into its `.rescribe/`.
- `claude -p --restricted` writes the markdown, following the workflow's prompt (`prompt.md` here is the one it starts with: the name's people, the notes, the board) between this runner's `before.md` (the worktree, `.rescribe/`) and `after.md` (the hand-over the script reads) and lawcel-knowledge's own CLAUDE.md, and hands back the name, a commit subject, a summary and the cards (`.rescribe/cards/<n>/`: `title`, `body.md`, `assignees`).
- `run.sh` bounds the cards, and nothing about them holds back the notes: more than ten files none; a card without a title or a body is left out; a title is cut to one line of 120 characters and a body to 2000; HTML, code fences and mentions in a body are made inert; an assignee who cannot be assigned is left out. What it leaves out, and anything out of place (in `.rescribe/`, new at the top of lawcel-knowledge, or a change to a hidden file or an agent's instructions, which is put back and kept in `set-aside/`), is named in the summary under "To look at", and the hand-over is kept in the run directory's `handover/`. Then it files the transcript under the name, commits, rebases on `origin/main` and pushes. The run counts as pushed only when its commit is on `origin/main`, and a meeting indexed again that changes nothing commits nothing and goes on; the human's clone is then fast-forwarded when nothing is in the way.
- Last, it reads the board again and files each card whose title is neither open there nor already filed from this call as an issue in `Lawcel/lawcel-knowledge` (the board adds it in Triage), ending in a line that links the meeting's note and says an agent filed it. The summary ends with the cards' numbers, and the numbers of those it left out as already on the board.

A run that fails before the push keeps its worktree and says where; one that fails while filing says which cards it filed, and keeps the cards in the run directory. The workflow's folder is the clone's path, and the cards follow that clone's remote.

It needs, on the machine that runs it: `claude` logged in on the subscription; lawcel-knowledge cloned (the workflow's folder; `~/Documents/git/lawcel-knowledge` to start with, changed in the editor) with a push that never prompts; and `gh` logged in (`gh auth login`) as someone who can create issues in `Lawcel/lawcel-knowledge`.
