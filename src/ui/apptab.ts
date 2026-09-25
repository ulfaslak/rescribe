// The app tab that owns the recorder, for the extension's other pages (the stop dialog, the
// start dialog, the processing tab): found by URL and by its answer to `query-status` (a
// duplicate app tab never listens), then addressed by tab id, as the service worker does
// (background.ts `tabStatus`), never broadcast: a broadcast would also reach the service worker
// and any duplicate app tab, and only the owner may answer for a recording.
import type { Message } from '../lib/messages.ts';

const APP_URL = chrome.runtime.getURL('app/app.html');
/** The owning app tab, once found; forgotten when it stops answering. */
let appTabId: number | undefined;

export async function appTab(): Promise<number | undefined> {
  if (appTabId !== undefined) return appTabId;
  for (const t of await chrome.tabs.query({ url: APP_URL })) {
    if (t.id === undefined) continue;
    const status = await chrome.tabs
      .sendMessage(t.id, { type: 'query-status' } satisfies Message)
      .catch(() => undefined);
    if (status !== undefined) {
      appTabId = t.id;
      return t.id;
    }
  }
  return undefined;
}

/** Ask the owning app tab; undefined when there is none or it does not answer. */
export async function askApp<T>(msg: Message): Promise<T | undefined> {
  const id = await appTab();
  if (id === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(id, msg)) as T | undefined;
  } catch {
    appTabId = undefined;
    return undefined;
  }
}
