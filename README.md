# Rescribe

Record a Google Meet call, a Teams call, a tab, a window or your whole screen from Chrome, and get two files in a folder of your choosing: the video and a transcript that says who said what. Nothing leaves your machine. Speech recognition runs in the browser on your GPU.

## Install

1. `npm install && npm run build`
2. Open `chrome://extensions` (Brave: `brave://extensions`, and enable `brave://flags/#file-system-access-api` first), turn on **Developer mode**, click **Load unpacked**, pick the `dist/` folder.
3. Pin the Rescribe button to the toolbar.
4. Open Rescribe from the toolbar, go to **Settings**, choose the folder recordings should be saved to.

The first transcription downloads the speech model once (about 650 MB, from huggingface.co) and caches it in the browser. After that it works offline.

## Use

- **Record a call:** open the Meet tab, click the Rescribe button (or press `Alt+Shift+R`). Press Stop in the Rescribe tab to finish; clicking the button again only brings that tab forward.
- **Record a screen or window:** open the Rescribe tab and press **Record screen…**, then pick what to share in Chrome's dialog. Ending the share from Chrome's bar also stops the recording.
- **Microphone:** on by default (Settings); the checkbox in the Record section decides per recording.

When you stop, the video is saved immediately into a folder named by the template in Settings (`{date} {time} {title}` by default), and the transcript is written as soon as transcription finishes. Keep the Rescribe tab open until then. If the tab closes mid-recording, what reached disk is recovered the next time you open Rescribe.

A recording that could not be saved to the folder (after a browser restart Chrome asks for the folder permission again, and it can only ask from a click) is kept and shows a **Save now** button in the list; click it to grant the permission and save. Keep one Rescribe tab: a second one only offers to take you to the first.

**Recordings** is the library. Click the pencil to rename a recording (the folder on disk keeps its name). **Re-export** writes the video and the transcript files into the folder again, recreating it if you deleted it. **Delete media** frees the video and audio Rescribe keeps in the browser and leaves the record and the folder alone; **Delete** removes the record too, still never the folder. Both ask you to click once more. The line under the list shows how much the browser holds; **Delete media for exported recordings** frees all of it at once.

## Develop

See `CLAUDE.md` and `AGENTS/DNA/DEVELOPMENT.md`.
