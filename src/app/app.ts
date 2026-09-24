// The app tab. Owns all state: recorder (planned), storage (planned), settings, library.
// The service worker only pokes it with messages. See ARCHITECTURE § Runtime topology.
import type { AppStatus, Message } from '../lib/messages.ts';
import { send } from '../lib/messages.ts';
import { idb } from '../lib/idb.ts';
import { loadSettings, saveSettings } from '../lib/settings.ts';
import type { Settings } from '../lib/types.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

let status: AppStatus = 'idle';

function setStatus(next: AppStatus): void {
  status = next;
  const pill = $<HTMLSpanElement>('#status');
  pill.textContent = next;
  pill.className = `pill ${next === 'recording' ? 'recording' : next === 'transcribing' ? 'processing' : ''}`;
  void send({
    type: 'badge',
    state: next === 'recording' ? 'recording' : next === 'transcribing' ? 'processing' : 'idle',
  });
}

// --- Messages from the service worker and content scripts ---------------------------------
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'query-status':
      sendResponse(status);
      return false;
    case 'toggle-recording':
      // Recorder arrives with the vertical slice. Until then, acknowledge and show the intent.
      console.info('[rescribe] toggle-recording', msg);
      return false;
    case 'speaker':
    case 'roster':
    case 'adapter-diagnostic':
      console.info('[rescribe] adapter', msg);
      return false;
    default:
      return false;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (status === 'recording' || status === 'transcribing') e.preventDefault();
});

// --- Settings -----------------------------------------------------------------------------
const FOLDER_KEY = 'export';

async function describeFolder(): Promise<void> {
  const name = $<HTMLOutputElement>('#folder-name');
  const hint = $<HTMLElement>('#folder-hint');
  const handle = await idb.get<FileSystemDirectoryHandle>('handles', FOLDER_KEY);
  if (!handle) {
    name.textContent = 'No folder chosen';
    hint.textContent = '';
    return;
  }
  name.textContent = handle.name;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  hint.textContent =
    perm === 'granted' ? '' : 'Chrome will ask for permission again on the next export.';
}

async function chooseFolder(): Promise<void> {
  const hint = $<HTMLElement>('#folder-hint');
  try {
    const handle = await window.showDirectoryPicker({ id: 'rescribe-export', mode: 'readwrite' });
    await idb.set('handles', FOLDER_KEY, handle);
    await describeFolder();
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') {
      hint.textContent =
        'Picker closed without a folder (AbortError). If you did pick one, report this: HUMAN_TODO.';
    } else {
      hint.textContent = `Could not choose folder: ${String(err)}`;
    }
  }
}

function bindSettings(settings: Settings): void {
  const form = $<HTMLFormElement>('#settings-form');
  const fields = form.elements;
  (fields.namedItem('pathTemplate') as HTMLInputElement).value = settings.pathTemplate;
  (fields.namedItem('myName') as HTMLInputElement).value = settings.myName;
  (fields.namedItem('container') as HTMLSelectElement).value = settings.container;
  (fields.namedItem('micByDefault') as HTMLInputElement).checked = settings.micByDefault;
  (fields.namedItem('model') as HTMLSelectElement).value = settings.model;

  let timer: number | undefined;
  form.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const data = new FormData(form);
      await saveSettings({
        pathTemplate: String(data.get('pathTemplate') || '{date} {time} {title}'),
        myName: String(data.get('myName') || 'Me'),
        container: data.get('container') === 'webm' ? 'webm' : 'mp4',
        micByDefault: data.get('micByDefault') === 'on',
        model: String(data.get('model') || settings.model),
      });
      const saved = $<HTMLElement>('#settings-saved');
      saved.textContent = 'Saved.';
      window.setTimeout(() => (saved.textContent = ''), 1500);
    }, 300);
  });
}

async function main(): Promise<void> {
  setStatus('idle');
  bindSettings(await loadSettings());
  $<HTMLButtonElement>('#choose-folder').addEventListener('click', () => void chooseFolder());
  await describeFolder();
}

void main();
