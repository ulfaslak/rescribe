// Service worker. Ephemeral: only the toolbar button, the keyboard command and the badge live
// here. Everything stateful happens in the app tab (app/app.ts). See ARCHITECTURE § Runtime
// topology.
import type { AppStatus, BadgeState, Message } from './lib/messages.ts';

const APP_URL = chrome.runtime.getURL('app/app.html');
const READY_TIMEOUT_MS = 5000;
const RELOAD_TIMEOUT_MS = 8000;

/** Ask one app tab for its status. Undefined when it is not listening (loading, discarded, a duplicate). */
async function tabStatus(tabId: number): Promise<AppStatus | undefined> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'query-status',
    } satisfies Message)) as AppStatus | undefined;
    return res;
  } catch {
    return undefined;
  }
}

/** Broadcast: answered by the one app tab that owns the recorder. 'idle' when none is open. */
async function queryStatus(): Promise<AppStatus> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'query-status' } satisfies Message)) as
      AppStatus | undefined;
    return res ?? 'idle';
  } catch {
    return 'idle';
  }
}

async function waitForAppReady(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await tabStatus(tabId)) !== undefined) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * The one app tab, listening. Opens it (pinned) when there is none; closes duplicates (a second
 * app tab never listens, see app.ts); reloads a tab that exists but does not answer (discarded by
 * the memory saver, stuck mid-reload, crashed). Undefined, with the badge in its error state, when
 * no tab answers in time: a silent no-op on the toolbar button is worse than a visible one.
 */
async function ensureAppTab(focus: boolean): Promise<chrome.tabs.Tab | undefined> {
  const tabs = (await chrome.tabs.query({ url: APP_URL })).filter((t) => t.id !== undefined);
  let owner: chrome.tabs.Tab | undefined;
  for (const t of tabs) {
    if ((await tabStatus(t.id!)) !== undefined) {
      owner = t;
      break;
    }
  }
  const keep = owner ?? tabs[0];
  for (const t of tabs) {
    if (t.id !== keep?.id) await chrome.tabs.remove(t.id!).catch(() => undefined);
  }
  if (keep?.id === undefined) {
    const tab = await chrome.tabs.create({ url: APP_URL, pinned: true, active: focus });
    if (tab.id === undefined || !(await waitForAppReady(tab.id, READY_TIMEOUT_MS))) {
      await setBadge('error');
      return undefined;
    }
    return tab;
  }
  if (focus) {
    await chrome.tabs.update(keep.id, { active: true });
    await chrome.windows.update(keep.windowId, { focused: true });
  }
  if (!owner) {
    await chrome.tabs.reload(keep.id).catch(() => undefined);
    if (!(await waitForAppReady(keep.id, RELOAD_TIMEOUT_MS))) {
      await setBadge('error');
      return undefined;
    }
  }
  return keep;
}

const BADGE: Record<BadgeState, { text: string; color: string; title: string }> = {
  idle: { text: '', color: '#000000', title: 'Rescribe: record this tab' },
  recording: { text: 'REC', color: '#d93025', title: 'Rescribe: recording (click to open)' },
  processing: { text: '…', color: '#1a73e8', title: 'Rescribe: transcribing (click to open)' },
  error: {
    text: '!',
    color: '#d93025',
    title: 'Rescribe: the Rescribe tab did not answer. Reload it, then click again.',
  },
};

async function setBadge(state: BadgeState): Promise<void> {
  const b = BADGE[state];
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setTitle({ title: b.title });
}

/**
 * The toolbar button. Idle: start recording the clicked tab (plus mic) through the app tab.
 * Otherwise: bring the app tab forward, where Stop lives. Misclicks must not stop a recording.
 *
 * The tab-capture stream id is obtained first, before any other await: the extension has just
 * been invoked on the tab, which is what `getMediaStreamId` requires. The id is consumed by
 * getUserMedia in the app tab (recorder/capture.ts) and is sent to that tab only, never
 * broadcast. Clicking on the app tab itself only focuses it.
 */
async function onToggle(tab?: chrome.tabs.Tab): Promise<void> {
  const target = tab?.id !== undefined && tab.url !== APP_URL ? tab : undefined;
  let streamId: string | undefined;
  let error: string | undefined;
  if (target?.id !== undefined) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const status = await queryStatus();
  const app = await ensureAppTab(true);
  if (app?.id === undefined || status !== 'idle' || !target?.id) return;
  await chrome.tabs
    .sendMessage(app.id, {
      type: 'toggle-recording',
      tabId: target.id,
      tabTitle: target.title,
      streamId,
      error,
    } satisfies Message)
    .catch(() => undefined);
}

chrome.action.onClicked.addListener((tab) => {
  void onToggle(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') void onToggle(tab ?? undefined);
});

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'badge') void setBadge(msg.state);
  else if (msg.type === 'focus-app') void ensureAppTab(true);
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('idle');
});
