// The privacy assertion behind INVARIANTS § "No audio, video or transcript ever leaves the
// machine": record every request a BrowserContext makes and fail on any network host outside the
// pinned set. Local schemes (chrome-extension:, blob:, data:) never leave the machine and are not
// counted. Use from any spec that records or transcribes.
import type { BrowserContext, Request } from '@playwright/test';

/**
 * The only hosts the model download may touch: huggingface.co itself (the repo listing and the
 * `/resolve/` URLs, which redirect) and the CDN host it redirects to. Observed 2026-09-24 in the
 * transcribe e2e run: `huggingface.co`, then `us.aws.cdn.hf.co` (Hugging Face's Xet CDN,
 * `<region>.<cloud>.cdn.hf.co`). Extend the list only after observing a new host in a run and
 * checking it belongs to Hugging Face.
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
  /** Every request seen so far, in order. */
  requests: SeenRequest[];
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
  const onRequest = (r: Request) => {
    const u = new URL(r.url());
    requests.push({ url: r.url(), scheme: u.protocol, host: u.host });
  };
  context.on('request', onRequest);
  const offending = () =>
    requests.filter(
      (r) => NETWORK_SCHEMES.has(r.scheme) && !ALLOWED_HOSTS.some((re) => re.test(r.host)),
    );
  return {
    requests,
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
    stop: () => context.off('request', onRequest),
  };
}
