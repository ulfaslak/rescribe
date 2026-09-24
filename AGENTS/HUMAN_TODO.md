# Human TODO

Manual tasks only the human can do. Agents remove entries when done and add entries only for things that genuinely need the human's hands. Not a backlog.

---

### Load the extension into Chrome

`npm run build`, then `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`. Pin the Rescribe button.

### Confirm the folder picker works from an extension tab

Open Rescribe from the toolbar, go to Settings, click **Choose folder**, pick any folder. The page should show the folder name. If Chrome throws "The user aborted a request" or the dialog never returns, tell an agent: that flips the storage export to the `chrome.downloads` fallback (see DECISIONS § Storage).
