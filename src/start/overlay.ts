// The start dialog inside the page: the service worker injects `mountStartOverlay` into the tab
// the toolbar button was clicked on (chrome.scripting, on the click's activeTab grant) and it
// hangs start/start.html in an iframe at the page's top right, over the page, with no backdrop.
// Both functions are serialized by chrome.scripting, so they may reference nothing outside
// themselves. The iframe talks to its host by postMessage only: `close` removes it, `size` fits
// its height to the dialog, `hide` and `show` take it out of sight while a start runs (the
// capture records this page); a message from anything but that iframe's window is ignored.

/** The id of the host element (a shadow host, so the page's CSS cannot reach the iframe). */
export const OVERLAY_ID = 'rescribe-start-overlay';

/**
 * Hang the dialog in the page. False when the page could not show it: in fullscreen only the
 * fullscreen element is drawn, and one that cannot hold a visible child (a video, a canvas, an
 * embedded player's frame, a shadow host) would swallow it; the service worker opens the window.
 */
export function mountStartOverlay(src: string, id: string): boolean {
  document.getElementById(id)?.remove();
  const within = (): Element | undefined => {
    const full = document.fullscreenElement;
    if (!full) return document.documentElement;
    const leaf =
      full instanceof HTMLVideoElement ||
      full instanceof HTMLCanvasElement ||
      full instanceof HTMLIFrameElement ||
      full instanceof HTMLImageElement ||
      full instanceof HTMLEmbedElement ||
      full instanceof HTMLObjectElement ||
      !!full.shadowRoot;
    return leaf ? undefined : full;
  };
  const parent = within();
  if (!parent) return false;
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
  frame.style.cssText =
    'display: block; width: 100%; height: 420px; max-height: calc(100vh - 24px); border: 0; ' +
    'border-radius: 14px; background: transparent; color-scheme: normal; ' +
    'box-shadow: 0 10px 34px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0, 0, 0, 0.08);';
  root.append(frame);
  const remove = (): void => {
    host.remove();
    window.removeEventListener('message', onMessage);
    document.removeEventListener('fullscreenchange', onFullscreen);
  };
  const onMessage = (e: MessageEvent): void => {
    if (!host.isConnected) return remove();
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const data = e.data as { rescribe?: string; height?: number } | null;
    if (data?.rescribe === 'close') remove();
    else if (data?.rescribe === 'hide') host.style.visibility = 'hidden';
    else if (data?.rescribe === 'show') host.style.visibility = 'visible';
    else if (data?.rescribe === 'size' && typeof data.height === 'number')
      frame.style.height = `${Math.ceil(data.height)}px`;
  };
  // Fullscreen entered or left while it is open: it follows into what is drawn, or goes.
  const onFullscreen = (): void => {
    if (!host.isConnected) return remove();
    const next = within();
    if (!next) remove();
    else if (host.parentElement !== next) next.append(host);
  };
  window.addEventListener('message', onMessage);
  document.addEventListener('fullscreenchange', onFullscreen);
  // On <html>, not <body>: a transformed or clipped body would carry a fixed child with it.
  parent.append(host);
  frame.addEventListener('load', () => frame.focus(), { once: true });
  return true;
}

export function unmountStartOverlay(id: string): void {
  document.getElementById(id)?.remove();
}
