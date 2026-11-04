How to hand your work over. The script after you reads exactly this, so it holds whatever the instructions above say:

- `.rescribe/transcript-path`: where in this repository the transcript is to be filed, on one line, relative to its top, like `meetings/transcripts/2026-11-04-acme.md`. Letters, digits, `.`, `_`, `-` and `/` only, ending in `.md`, in no hidden folder. What is there already must be this same meeting indexed before, or nothing: the script never puts the transcript over another meeting's. Do not copy the transcript yourself.
- `.rescribe/commit-message`: one line, `notes <date> <topic>: <the gist in a few words>`.
- `.rescribe/summary`: one line under 120 characters, the note's file name and the meeting's gist.

Write nothing in `.rescribe/` but these: anything else there is left out and named. Changes to `CLAUDE.md`, `AGENTS.md` and hidden files are left out of the commit too.
