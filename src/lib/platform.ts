// Which call platform a tab's URL belongs to. The service worker uses it to decide whether a
// toolbar click leaves the human where they are (DECISIONS § Form factor). Must agree with the
// manifest's content_scripts matches: a platform is a page one of our adapters runs on.
import type { Platform } from './messages.ts';

const HOSTS: Record<string, Platform> = {
  'meet.google.com': 'meet',
};

/** The platform whose adapter runs on `url`, or undefined for any other page. */
export function platformOf(url: string | undefined): Platform | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  return HOSTS[parsed.hostname];
}
