// The dialog windows (the stop dialog, the start dialog) are popup-type windows the service
// worker opens; each closes itself through chrome.windows, since window.close() is refused for a
// window a script did not open.
export async function closeThisWindow(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) await chrome.windows.remove(win.id);
    else window.close();
  } catch {
    window.close();
  }
}
