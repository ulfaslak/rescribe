You are running headless. Rescribe started you after it recorded and transcribed a meeting, and the human chose "Index in Lawcel" for it. Nobody is watching and nobody will answer a question: make every call yourself, the way this repository's CLAUDE.md says, and finish the job.

You are in a fresh git worktree of lawcel-knowledge, on a branch that tracks `origin/main`. Follow CLAUDE.md here, except where this prompt says otherwise.

The meeting's files are in `{{RECORDING_DIR}}`:

- `transcript.md`: the speaker-attributed transcript. Its header has the title, the local start date and time, and the participants.
- `meta.json`: the same as JSON (`participants`, `startedAt` in epoch ms, `selfTile` is Ulf's own Meet tile).

Leave the video and `transcript.json` alone.

1. **File the transcript.** Copy `transcript.md`, that file only, to `meetings/transcripts/<date>-<names>.md`. `<date>` is the meeting's date from the header, `YYYY-MM-DD`. `<names>` is each participant's first name, lowercase and ASCII (æ → ae, ø → o, å → a, accents dropped), joined with hyphens, in the order the existing files use (look at `ls meetings/transcripts`): kenneth, then ulf, then everyone else. Leave out a "participant" that is not a person (a Meet code, "Speaker"). If that file already exists for a different meeting, add `-2` (`-3`, …). If it is this same meeting, indexed before, reuse the name and update the existing notes rather than write a second set.
2. **Take notes from it**, as you would if asked "take notes from meetings/transcripts/<that file>". Read the whole transcript and what the repository already knows about the people and topics in it. Write `meetings/notes/<same name>.md` following `meetings/notes/_template.md`. Update `crm/`, `decisions/`, `questions/` and `reminders.md` as CLAUDE.md describes. A person the meeting introduces gets a CRM entry. Do not create GitHub issues or touch the project board.
3. **Sync.** Commit everything in one commit (`notes <date> <names>: <the gist in a few words>`), then `git pull --rebase origin main` and `git push origin HEAD:main`. Resolve conflicts if there are any; retry if the push is rejected. You are not done until the push has succeeded.

Last, write one line of under 120 characters to `{{SUMMARY_FILE}}`: the note's file name and the meeting's gist.
