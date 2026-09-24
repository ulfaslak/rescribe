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

When you stop, the video is saved immediately into a folder named by the template in Settings (`{date} {time} {title}` by default), and the transcript is written as soon as transcription finishes. Keep the Rescribe tab open until then. If the tab closes mid-recording, what reached disk is recovered and saved the next time you open Rescribe.

## Develop

See `CLAUDE.md` and `AGENTS/DNA/DEVELOPMENT.md`.
