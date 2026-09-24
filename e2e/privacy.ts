// The privacy assertion behind INVARIANTS § "No audio, video or transcript ever leaves the
// machine": record every HTTP(S) request a BrowserContext makes (pages and their workers) and
// every WebSocket a page opens, and fail on any network host outside the pinned set. Local schemes
// (chrome-extension:, blob:, data:) never leave the machine and are not counted. Use from any spec
// that records or transcribes.
import type { BrowserContext, Page, Request } from '@playwright/test';

/**
 * The only hosts the model download may touch: huggingface.co itself (the `/resolve/` URLs, which
 * redirect) and the CDN host they redirect to. Observed 2026-09-24 in the transcribe e2e run:
 * `huggingface.co`, then `us.aws.cdn.hf.co` (Hugging Face's Xet CDN, `<region>.<cloud>.cdn.hf.co`).
 * Extend the list only after observing a new host in a run and checking it belongs to Hugging Face.
 */
export const ALLOWED_HOSTS: RegExp[] = [
  /^huggingface\.co$/,
  /^[a-z0-9-]+\.[a-z0-9-]+\.cdn\.hf\.co$/,
];

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

export interface SeenRequest {
  url: string;
  scheme: string;
  host: string;
}

export interface NetworkWatch {
  /** Every request and WebSocket seen so far, in order, local schemes included. */
  requests: SeenRequest[];
  /** The subset that actually goes over the network (http, https, ws, wss). */
  networkRequests(): SeenRequest[];
  /** Distinct `scheme//host` pairs seen so far. */
  origins(): string[];
  /** Network requests whose host is not in ALLOWED_HOSTS. */
  offending(): SeenRequest[];
  /** Throws with the offending URLs when anything left the machine for a non-allowed host. */
  assertOnlyAllowed(): void;
  stop(): void;
}

export function watchNetwork(context: BrowserContext): NetworkWatch {
  const requests: SeenRequest[] = [];
  const record = (url: string) => {
    const u = new URL(url);
    requests.push({ url, scheme: u.protocol, host: u.host });
  };
  const onRequest = (r: Request) => record(r.url());
  // context.on('request') never fires for WebSockets; those come per page.
  const onPage = (page: Page) => page.on('websocket', (ws) => record(ws.url()));
  context.on('request', onRequest);
  context.on('page', onPage);
  context.pages().forEach(onPage);

  const networkRequests = () => requests.filter((r) => NETWORK_SCHEMES.has(r.scheme));
  const offending = () =>
    networkRequests().filter((r) => !ALLOWED_HOSTS.some((re) => re.test(r.host)));
  return {
    requests,
    networkRequests,
    origins: () => [...new Set(requests.map((r) => `${r.scheme}//${r.host}`))],
    offending,
    assertOnlyAllowed: () => {
      const bad = offending();
      if (bad.length) {
        throw new Error(
          `requests left the machine for non-allowed hosts:\n${[...new Set(bad.map((r) => r.url))].join('\n')}`,
        );
      }
    },
    stop: () => {
      context.off('request', onRequest);
      context.off('page', onPage);
    },
  };
}
