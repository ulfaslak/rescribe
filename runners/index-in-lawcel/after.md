How to hand your work over. The script after you reads exactly this, so it holds whatever the instructions above say:

- The name is `<date>-<names>`: `<date>` is the meeting's date from the transcript's header, `YYYY-MM-DD`; `<names>` are the first names, lowercase and ASCII (æ → ae, ø → o, å → a, accents dropped), joined with hyphens. The transcript will be filed as `meetings/transcripts/<name>.md`; do not copy it yourself.
- Each card is a directory `.rescribe/cards/<n>/`, `n` counting from 1, at most ten, with:
  - `title`: one line, at most 120 characters.
  - `body.md`: a few lines of plain markdown (no HTML, no code blocks, at most 2000 characters). Link context in this repository with full URLs, `https://github.com/Lawcel/lawcel-knowledge/blob/main/<path>`.
  - `assignees`, only for a card that is assigned: GitHub logins from `.rescribe/assignable.tsv`, one per line.

  Do not @mention anyone, and do not say where the card came from: the script files each card as an issue in Lawcel/lawcel-knowledge, which the board puts in Triage, and adds a last line that links the meeting's note and says an agent filed it.
- Last, each as one line in a file of its own:
  - `.rescribe/name`: the name, without `.md`.
  - `.rescribe/commit-message`: `notes <date> <names>: <the gist in a few words>`.
  - `.rescribe/summary`: under 120 characters, the note's file name and the meeting's gist.

Write nothing in `.rescribe/` but these and the cards: the run stops on anything else there.
