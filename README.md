# Rescribe

Record a Google Meet call, a Teams call, a tab, a window or your whole screen from Chrome, and get two files in a folder of your choosing: the video and a transcript that says who said what. Nothing leaves your machine. Speech recognition runs in the browser on your GPU.

## Install

1. `npm install && npm run build`
2. Open `chrome://extensions` (Brave: `brave://extensions`, and enable `brave://flags/#file-system-access-api` first), turn on **Developer mode**, click **Load unpacked**, pick the `dist/` folder.
3. Pin the Rescribe button to the toolbar.
4. `npm run install-host` (from this clone, once): connects the workflows to the browser and creates `~/.rescribe/recordings`.
5. Open Rescribe from the toolbar, go to **Settings**, choose `~/.rescribe/recordings` as the folder (`⌘⇧G` in the picker to type the path): workflows read recordings from there.

The first transcription downloads the speech model once (about 650 MB, from huggingface.co) and caches it in the browser. After that it works offline.

## Use

- **Record a call:** open the Meet tab, click the Rescribe button (or press `Alt+Shift+R`). The badge shows `REC` and you stay in the call. To finish, click the button again: a small window asks what should happen to the recording. **Save** puts it in the folder from Settings and transcribes it; a workflow, such as **Index in Lawcel**, does the same and then hands the transcript to Claude Code (below); **Discard** (click it twice) deletes it without writing anything; Escape keeps recording. Leaving the call opens the same window while the recording goes on, so rejoining loses nothing.
- **Record a screen or window:** open the Rescribe tab and press **Record screen…**, then pick what to share in Chrome's dialog. Stop in the Rescribe tab saves in one click. Ending the share from Chrome's bar leaves the recording waiting: the window opens, the badge says `SAVE`, and the recording's row in the Rescribe tab offers the same choices until you make one.
- **Microphone:** on by default (Settings); the checkbox in the Record section decides per recording.

When you save, the video goes into a folder named by the template in Settings (`{date} {time} {title}` by default), and transcription starts (turn that off in Settings to run it from the list later): the status line shows the model download the first time, then the progress, and `transcript.md`, `transcript.json` and `meta.json` are written next to the video when it finishes. Keep the Rescribe tab open until then; a reload picks the transcription up again. The speech engine runs on WASM by default; Settings offers WebGPU when your GPU is up to it. If the tab closes mid-recording, what reached disk is recovered the next time you open Rescribe.

A recording that could not be saved to the folder (after a browser restart Chrome asks for the folder permission again, and it can only ask from a click), or whose transcript could not be written next to its video (no folder yet, or the folder changed meanwhile), is kept and shows a **Save now** button in the list; click it to grant the permission and save the video and the transcript together. Keep one Rescribe tab: a second one only offers to take you to the first.

**Recordings** is the library: one line per recording until you click it open (the newest is open already). Click the pencil to rename a recording (the folder on disk keeps its name). **Re-export** writes the video and the transcript files into the folder again, recreating it if you deleted it. **Re-run transcription** makes the transcript again, after changing your name in Settings for instance. **Delete media** frees the video and audio Rescribe keeps in the browser and leaves the record and the folder alone; **Delete** removes the record too, still never the folder. Both ask you to click once more. The line under the list shows how much the browser holds; **Delete media for exported recordings** frees all of it at once.

## Workflows

A workflow is what happens to a recording after its transcript is in the folder: a prompt you write, given to Claude Code (headless, on your subscription). Pick one in the window at the end of the recording, or later with **Run workflow…** on the recording's row. It runs outside the browser, so you can close Rescribe while it works; a notification says when it is done, and the row shows how it went and where its log is.

Make and change them under **Workflows** in the Rescribe tab: a name, a line about it, the folder Claude Code works in, and the prompt. Click a variable (`{{title}}`, `{{date}}`, `{{time}}`, `{{participants}}`, `{{transcript}}`, `{{folder}}`, `{{workflow}}`) to put it in the prompt; it is filled in when the workflow runs. A workflow runs with one of two runners:

- **Claude Code in a folder**: Claude Code reads the transcript and reads and writes files in the folder, nothing else (no shell, no web), and says in a line what it did. Choose a folder of notes, not one with code or keys: anyone on the call could try to steer it, and Rescribe refuses folders that hold keys, settings or Rescribe's own files.
- **Index in Lawcel**: Claude Code copies the transcript into `lawcel-knowledge/meetings/transcripts/<date>-<names>.md`, writes the meeting's note, updates the CRM, decisions, questions and reminders, and pushes to `main`; the call's action items become cards on the founders' board. Rescribe starts with this one workflow.

The workflows are files in `~/.rescribe/workflows/<id>/` (`workflow.json`, `prompt.md`); a deleted one goes to `.trash/` there. The runners are code in `runners/` (see `runners/README.md`).

## Develop

See `CLAUDE.md` and `AGENTS/DNA/DEVELOPMENT.md`.
