// The dialog windows (the stop dialog, the start dialog) are popup-type windows the service
// worker opens; each closes itself through chrome.windows, since window.close() is refused for a
// window a script did not open. Only a popup window is removed whole: the page can end up as a
// tab in a browser window ("Show as tab", a history entry, a restored session), and closing
// that window would take the call and every other tab with it; then only the tab goes.
export async function closeThisWindow(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent();
    if (win.type === 'popup' && win.id !== undefined) {
      await chrome.windows.remove(win.id);
      return;
    }
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
    else window.close();
  } catch {
    window.close();
  }
}
