// Service worker. Ephemeral: only the toolbar button, the keyboard command, the badge and the
// windows and tabs it opens live here. Everything stateful happens in the app tab (app/app.ts).
// See ARCHITECTURE § Runtime topology.
import type { AppStatus, BadgeState, Message, StartResult } from './lib/messages.ts';
import { platformOf } from './lib/platform.ts';
import { mountStartOverlay, OVERLAY_ID, unmountStartOverlay } from './start/overlay.ts';

const APP_URL = chrome.runtime.getURL('app/app.html');
const STOP_URL = chrome.runtime.getURL('stop/stop.html');
const START_URL = chrome.runtime.getURL('start/start.html');
const PROGRESS_URL = chrome.runtime.getURL('progress/progress.html');
const READY_TIMEOUT_MS = 5000;
const RELOAD_TIMEOUT_MS = 8000;
/**
 * The dialog windows (stop/stop.html, and start/start.html where a page cannot host it): small,
 * near the top right of the browser window.
 */
const STOP_WIDTH = 420;
const STOP_HEIGHT = 300;
const START_WIDTH = 400;
const START_HEIGHT = 440;

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
 * The browser window the human is in: the last focused normal one. New tabs (the app tab, the
 * processing tab) go there by id, never into "the current window", which from this worker can
 * be one of the dialog windows while it has focus.
 */
async function normalWindow(): Promise<chrome.windows.Window | undefined> {
  return chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

/** One `ensureAppTab` at a time: two in flight (a click and its Start) would create two app tabs. */
let ensuring: Promise<chrome.tabs.Tab | undefined> | undefined;

/**
 * The one app tab, listening. Opens it (pinned) when there is none; closes duplicates (a second
 * app tab never listens, see app.ts); reloads a tab that exists but does not answer (discarded by
 * the memory saver, stuck mid-reload, crashed). Undefined, with the badge in its error state, when
 * no tab answers in time: a silent no-op on the toolbar button is worse than a visible one.
 */
async function ensureAppTab(focus: boolean): Promise<chrome.tabs.Tab | undefined> {
  if (ensuring) {
    const tab = await ensuring;
    if (tab && focus) await focusTab(tab);
    return tab;
  }
  ensuring = ensureAppTabNow(focus).finally(() => {
    ensuring = undefined;
  });
  return ensuring;
}

async function ensureAppTabNow(focus: boolean): Promise<chrome.tabs.Tab | undefined> {
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
    const anchor = await normalWindow();
    const tab = await chrome.tabs.create({
      url: APP_URL,
      pinned: true,
      active: focus,
      ...(anchor?.id !== undefined ? { windowId: anchor.id } : {}),
    });
    if (tab.id === undefined || !(await waitForAppReady(tab.id, READY_TIMEOUT_MS))) {
      await setBadge('error');
      return undefined;
    }
    if (focus) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    return tab;
  }
  if (focus) await focusTab(keep);
  if (!owner) {
    await chrome.tabs.reload(keep.id).catch(() => undefined);
    if (!(await waitForAppReady(keep.id, RELOAD_TIMEOUT_MS))) {
      await setBadge('error');
      return undefined;
    }
  }
  return keep;
}

/** The tabs of the dialog windows and the processing tabs under `url` (its query string aside). */
async function pagesAt(url: string): Promise<chrome.tabs.Tab[]> {
  return (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url));
}

/**
 * A dialog window: one small popup-type window over the browser window the human is in. Found
 * by URL rather than remembered, because this worker is ephemeral and forgets between events.
 */
async function openDialogWindow(url: string, width: number, height: number): Promise<void> {
  const anchor = await normalWindow();
  const placed =
    anchor?.left !== undefined && anchor.width !== undefined
      ? {
          left: Math.max(0, anchor.left + anchor.width - width - 24),
          top: Math.max(0, (anchor.top ?? 0) + 72),
        }
      : {};
  const create = { url, type: 'popup' as const, width, height };
  try {
    await chrome.windows.create({ ...create, focused: true, ...placed });
  } catch (err) {
    // Chrome refuses bounds that are not mostly on a visible screen ("Invalid value for
    // bounds"): a browser window half off-screen, a display that went away, headless. Chrome's
    // own placement then; the dialog matters more than where it lands.
    console.warn('[rescribe] dialog at the computed position refused; default placement', err);
    await chrome.windows.create({ ...create, focused: true });
  }
}

/**
 * Close every page under `url`: its window when that is the popup it was opened in, only the
 * tab when the page ended up in a browser window ("Show as tab", a history entry, a restored
 * session), which must not take the call and every other tab with it. Returns the closed pages'
 * URLs.
 */
async function closeDialogs(url: string): Promise<string[]> {
  const closed: string[] = [];
  for (const t of await pagesAt(url)) {
    const win = await chrome.windows.get(t.windowId).catch(() => undefined);
    if (win?.type === 'popup') await chrome.windows.remove(t.windowId).catch(() => undefined);
    else if (t.id !== undefined) await chrome.tabs.remove(t.id).catch(() => undefined);
    if (t.url) closed.push(t.url);
  }
  return closed;
}

/** The start dialog page for one tab. */
const startUrlFor = (tabId: number): string => `${START_URL}?tab=${tabId}`;

/**
 * The start dialogs open right now, wherever they are: an overlay's iframe in a page (`frameId`
 * above 0) or the fallback popup window's page (`frameId` 0). Asked of Chrome, since chrome.tabs
 * does not list frames and this worker forgets between events.
 */
async function startDialogs(): Promise<chrome.runtime.ExtensionContext[]> {
  const contexts = await chrome.runtime
    .getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] })
    .catch(() => []);
  return contexts.filter((c) => c.documentUrl?.startsWith(START_URL));
}

/**
 * Close every start dialog: an overlay is taken out of its page, a fallback window as in
 * `closeDialogs`. Returns the closed dialogs' URLs.
 */
async function closeStartDialogs(): Promise<string[]> {
  const closed: string[] = [];
  for (const c of await startDialogs()) {
    if (c.frameId > 0 && c.tabId >= 0)
      await chrome.scripting
        .executeScript({
          target: { tabId: c.tabId },
          func: unmountStartOverlay,
          args: [OVERLAY_ID],
        })
        .catch(() => undefined);
    if (c.documentUrl) closed.push(c.documentUrl);
  }
  closed.push(...(await closeDialogs(START_URL)));
  return [...new Set(closed)];
}

/**
 * The stop dialog. Opened on a toolbar click while `recording` or `stopped`, and on the app
 * tab's `ask-to-save` (the call ended, the share ended). One at a time: an open one is focused
 * instead.
 */
async function openStopDialog(): Promise<void> {
  const open = (await pagesAt(STOP_URL))[0];
  if (open?.windowId !== undefined) {
    try {
      await chrome.windows.update(open.windowId, { focused: true, drawAttention: true });
      return;
    } catch {
      // closed between the query and the update
    }
  }
  await openDialogWindow(STOP_URL, STOP_WIDTH, STOP_HEIGHT);
}

/**
 * The start dialog, for the tab the button was clicked on (the dialog reads the tab by id): an
 * overlay at the top right of that very page (start/overlay.ts), injected on the click's
 * activeTab grant. A page that cannot host it (the browser's own pages, the Web Store, file://
 * without file access, another extension's page) gets the popup window instead. One at a time:
 * `onToggle` closes an open one before it gets here. The app tab is opened, or left, in the
 * background meanwhile: Start needs it, and its cold start takes a moment.
 */
async function openStartDialog(target: chrome.tabs.Tab): Promise<void> {
  const url = startUrlFor(target.id!);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.id! },
      func: mountStartOverlay,
      args: [url, OVERLAY_ID],
    });
  } catch (err) {
    console.info('[rescribe] no overlay on this page; the start window instead', err);
    await openDialogWindow(url, START_WIDTH, START_HEIGHT);
  }
  void ensureAppTab(false);
}

/**
 * The processing tab for one recording, in the browser window the human is in, in front; an
 * open one is focused instead. The stop dialog that asked for it closes itself once the export
 * answers; removing its window from here, or at once, crashed Chrome for Testing
 * (ENVIRONMENT_NOTES § "Chrome for Testing crashes when a popup window is removed right after
 * Save as…").
 */
async function openProgressTab(id: string): Promise<void> {
  const url = `${PROGRESS_URL}?id=${encodeURIComponent(id)}`;
  const open = (await chrome.tabs.query({})).find((t) => t.url === url);
  if (open) {
    await focusTab(open);
    return;
  }
  const anchor = await normalWindow();
  await chrome.tabs.create({
    url,
    active: true,
    ...(anchor?.id !== undefined ? { windowId: anchor.id } : {}),
  });
}

const BADGE: Record<BadgeState, { text: string; color: string; title: string }> = {
  idle: { text: '', color: '#000000', title: 'Rescribe: record this tab' },
  recording: {
    text: 'REC',
    color: '#d93025',
    title: 'Rescribe: recording (click to save, save as or discard)',
  },
  pending: {
    text: 'SAVE',
    color: '#e37400',
    title:
      'Rescribe: a recording is waiting in the Rescribe tab (save, save as or discard); a click here still records this tab',
  },
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
 * The toolbar button (and the keyboard command). It toggles the start dialog: idle, or a
 * recording waiting `stopped` (it never blocks a new one; its dialog is a click on the app tab
 * or its row away), a click on a tab opens the start dialog for that tab; a click while the
 * dialog is open closes it, or moves it to the clicked tab when that is another one. Nothing
 * records until Start Capture in the dialog (`startCapture` below). Recording: open the stop
 * dialog, where Save, Save as… and Discard live; closing it keeps recording, so a misclick stops
 * nothing. Anything else (a start under way, which may be waiting on the human; the recorder
 * draining; an export running), and a click on the app tab itself: bring the app tab forward.
 *
 * The human stays where they are: the app tab is opened, or left, in the background (the badge
 * and the dialogs are the feedback) and comes forward on its own only when a start needs the
 * human (app.ts `comeForward`: a microphone permission prompt, which Chrome only shows for a
 * visible tab, or a start that failed inside the app tab).
 */
async function onToggle(tab?: chrome.tabs.Tab): Promise<void> {
  const target = tab?.id !== undefined && tab.url !== APP_URL ? tab : undefined;
  const closed = await closeStartDialogs();
  const status = await queryStatus();
  if (status === 'recording' || (status === 'stopped' && !target)) {
    await openStopDialog();
    return;
  }
  // The toggle: the dialog for this very tab was open, so the click closes it and that is all.
  if (target?.id !== undefined ? closed.includes(startUrlFor(target.id)) : closed.length > 0)
    return;
  const canStart = status === 'idle' || status === 'stopped';
  if (!canStart || !target) {
    await ensureAppTab(true);
    return;
  }
  await openStartDialog(target);
}

/**
 * Start Capture in the start dialog: the recording of the tab the dialog was opened for, plus
 * the microphone it chose, through the app tab. `ok` means the app tab took the start; a start
 * already under way (the app tab may be waiting on a microphone prompt) is refused and the app
 * tab brought forward, and a dialog closed while its Start waited for the app tab (Escape, the
 * toolbar button) cancels it: the human backed out, nothing may record behind their back.
 *
 * The tab-capture stream id is bound to the app tab (`consumerTabId`) and requested last. Without
 * `consumerTabId` Chromium binds the id to the caller's render process, the service worker's; the
 * app tab is cross-origin isolated (COOP/COEP, for multithreaded WASM) and runs in another
 * process, so getUserMedia there fails with "AbortError: Error starting tab capture" (observed in
 * Brave, 2026-09-24). Ordering: the invocation grant on the target tab, from the click that
 * opened the dialog, lasts until it navigates, so waiting for the app tab first is safe; the id
 * itself expires 10 s after it is issued (Chromium's DesktopStreamsRegistry), so it is issued
 * right before it is sent. The id is consumed by getUserMedia in the app tab
 * (recorder/capture.ts) and is sent to that tab only, never broadcast.
 */
async function startCapture(
  msg: Extract<Message, { type: 'start-capture' }>,
): Promise<StartResult> {
  let target: chrome.tabs.Tab;
  try {
    target = await chrome.tabs.get(msg.tabId);
  } catch {
    return { ok: false, error: 'The tab to record is closed.' };
  }
  if (target.id === undefined || target.url === APP_URL)
    return { ok: false, error: 'That tab cannot be recorded.' };
  const status = await queryStatus();
  if (status === 'recording')
    return { ok: false, error: 'Rescribe is already recording; the toolbar button stops it.' };
  if (status === 'starting') {
    void ensureAppTab(true);
    return {
      ok: false,
      error: 'A recording is already starting; it may need you in the Rescribe tab.',
    };
  }
  if (status !== 'idle' && status !== 'stopped')
    return { ok: false, error: 'Rescribe is busy finishing a recording; try again in a moment.' };
  const app = await ensureAppTab(false);
  if (app?.id === undefined)
    return { ok: false, error: 'The Rescribe tab did not answer. Reload it, then try again.' };
  const url = startUrlFor(target.id);
  if (!(await startDialogs()).some((c) => c.documentUrl === url))
    return { ok: false, error: 'Cancelled: the start dialog was closed.' };
  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: target.id,
      consumerTabId: app.id,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't capture that tab (${describe(err)}). Open Rescribe and use "Record screen…" to pick it instead.`,
    };
  }
  try {
    await chrome.tabs.sendMessage(app.id, {
      type: 'toggle-recording',
      tabId: target.id,
      tabTitle: target.title,
      streamId,
      mic: msg.mic,
      micDeviceId: msg.micDeviceId,
    } satisfies Message);
  } catch (err) {
    return {
      ok: false,
      error: `The Rescribe tab did not take the recording (${describe(err)}); try again.`,
    };
  }
  return { ok: true };
}

chrome.action.onClicked.addListener((tab) => {
  void onToggle(tab);
});

// For DevTools and the e2e harness: the toolbar click with a Tab-shaped object (id, url, title),
// the stop dialog on its own, and Start Capture as the start dialog sends it.
(globalThis as unknown as { rescribe: unknown }).rescribe = {
  onToggle,
  openStopDialog,
  startCapture,
};

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') void onToggle(tab ?? undefined);
});

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'badge') void setBadge(msg.state);
  else if (msg.type === 'focus-app') void ensureAppTab(true);
  else if (msg.type === 'ask-to-save') void openStopDialog();
  else if (msg.type === 'open-progress') void openProgressTab(msg.id);
  else if (msg.type === 'start-capture') {
    void startCapture(msg).then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('idle');
});
