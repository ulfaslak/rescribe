// Service worker. Ephemeral: only the toolbar button, the keyboard command and the badge live
// here. Everything stateful happens in the app tab (app/app.ts). See ARCHITECTURE § Runtime
// topology.
import type { AppStatus, BadgeState, Message } from './lib/messages.ts';

const APP_URL = chrome.runtime.getURL('app/app.html');

async function getAppTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ url: APP_URL });
  return tab;
}

/** Open the app tab (pinned) or bring the existing one forward. Resolves once it can receive messages. */
async function ensureAppTab(focus: boolean): Promise<chrome.tabs.Tab> {
  const existing = await getAppTab();
  if (existing?.id !== undefined) {
    if (focus) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing;
  }
  const tab = await chrome.tabs.create({ url: APP_URL, pinned: true, active: focus });
  await waitForAppReady();
  return tab;
}

async function queryStatus(): Promise<AppStatus> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'query-status' } satisfies Message)) as
      AppStatus | undefined;
    return res ?? 'idle';
  } catch {
    return 'idle';
  }
}

async function waitForAppReady(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'query-status' } satisfies Message);
      if (res !== undefined) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const BADGE: Record<BadgeState, { text: string; color: string; title: string }> = {
  idle: { text: '', color: '#000000', title: 'Rescribe: record this tab' },
  recording: { text: 'REC', color: '#d93025', title: 'Rescribe: recording (click to open)' },
  processing: { text: '…', color: '#1a73e8', title: 'Rescribe: transcribing (click to open)' },
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
 * getUserMedia in the app tab (recorder/capture.ts). Clicking on the app tab itself only focuses it.
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
  await ensureAppTab(true);
  if (status !== 'idle' || !target?.id) return;
  await chrome.runtime
    .sendMessage({
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
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('idle');
});
