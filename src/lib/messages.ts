// Every message that crosses chrome.runtime (service worker, app tab, content scripts) is a
// member of this union. It is the single roster of those message types. Workers speak
// postMessage, and each worker's protocol is typed in its own file under src/workers/.
import type { RecordingStatus } from './types.ts';

export type BadgeState = 'idle' | 'recording' | 'processing' | 'error';

export type Platform = 'meet';

export type Message =
  /** App tab → service worker: reflect state on the toolbar button. */
  | { type: 'badge'; state: BadgeState }
  /**
   * Service worker → app tab, or a second app tab → the first: is anything going on? Answered
   * with an AppStatus by the one app tab that owns the recorder (a duplicate tab never listens).
   */
  | { type: 'query-status' }
  /**
   * A duplicate app tab → service worker: bring the owning app tab forward and close me. Also the
   * owning app tab → service worker: a start left in the background needs the human (a permission
   * prompt, an error), bring me forward.
   */
  | { type: 'focus-app' }
  /**
   * Service worker → app tab: the toolbar button or the keyboard command fired on `tabId`.
   * `streamId` is the tab-capture id to consume with getUserMedia; when it could not be obtained,
   * `error` says why and the app tab shows it (there is no picker fallback: getDisplayMedia needs
   * a gesture in the app tab).
   */
  | {
      type: 'toggle-recording';
      tabId?: number;
      tabTitle?: string;
      streamId?: string;
      error?: string;
    }
  /**
   * Content script → app tab: a participant started or stopped speaking. `at` is wall-clock ms of
   * the change itself, not of its detection. `id` is the platform's participant id; `name` is
   * resolved once at the start and repeated on the stop, so the pair always matches.
   */
  | { type: 'speaker'; platform: Platform; at: number; id: string; name: string; speaking: boolean }
  /** Content script → app tab: the participants currently visible. */
  | { type: 'roster'; platform: Platform; at: number; names: string[] }
  /** Content script → app tab: the adapter can't do its job and says so. */
  | { type: 'adapter-diagnostic'; platform: Platform; at: number; message: string };

export type AppStatus = 'idle' | RecordingStatus;

/** Fire-and-forget send. Resolves to undefined when nobody is listening. */
export function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}
