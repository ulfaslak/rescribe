// The start dialog inside the page: the service worker injects `mountStartOverlay` into the tab
// the toolbar button was clicked on (chrome.scripting, on the click's activeTab grant) and it
// hangs start/start.html in an iframe at the page's top right, over the page, with no backdrop.
// Both functions are serialized by chrome.scripting, so they may reference nothing outside
// themselves. The iframe talks to its host by postMessage only: `close` removes it, `size` fits
// its height to the dialog; a message from anything but that iframe's window is ignored.

/** The id of the host element (a shadow host, so the page's CSS cannot reach the iframe). */
export const OVERLAY_ID = 'rescribe-start-overlay';

export function mountStartOverlay(src: string, id: string): void {
  document.getElementById(id)?.remove();
  const origin = new URL(src).origin;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText =
    'all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647; ' +
    'width: 380px; max-width: calc(100vw - 24px); display: block;';
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.title = 'Rescribe';
  // The microphone list needs the permission delegated to the frame, or it has no labels.
  frame.allow = 'microphone';
  frame.style.cssText =
    'display: block; width: 100%; height: 420px; border: 0; border-radius: 14px; ' +
    'box-shadow: 0 10px 34px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0, 0, 0, 0.08); ' +
    'background: transparent; color-scheme: normal;';
  root.append(frame);
  const onMessage = (e: MessageEvent): void => {
    if (!host.isConnected) {
      window.removeEventListener('message', onMessage);
      return;
    }
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const data = e.data as { rescribe?: string; height?: number } | null;
    if (data?.rescribe === 'close') {
      host.remove();
      window.removeEventListener('message', onMessage);
    } else if (data?.rescribe === 'size' && typeof data.height === 'number') {
      frame.style.height = `${Math.ceil(Math.min(data.height, window.innerHeight - 24))}px`;
    }
  };
  window.addEventListener('message', onMessage);
  // On <html>, not <body>: a transformed or clipped body would carry a fixed child with it.
  document.documentElement.append(host);
  frame.addEventListener('load', () => frame.focus(), { once: true });
}

export function unmountStartOverlay(id: string): void {
  document.getElementById(id)?.remove();
}
