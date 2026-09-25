// Every message that crosses chrome.runtime (service worker, app tab, content scripts) is a
// member of this union. It is the single roster of those message types. Workers speak
// postMessage, and each worker's protocol is typed in its own file under src/workers/.
import type { RecordingStatus } from './types.ts';

/** `pending`: a stopped recording waits for the human's decision (save, save as, discard). */
export type BadgeState = 'idle' | 'recording' | 'pending' | 'processing' | 'error';

/** What the human does with a recording once it stops (or to stop it). */
export type Decision = 'save' | 'save-as' | 'discard';

/** The recording the stop dialog is about: the live one, or the newest one waiting `stopped`. */
export interface PendingInfo {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  /** True while the recorder still runs; false once it stopped and waits for the decision. */
  live: boolean;
}

/** The app tab's answer to a `decide` message. */
export interface DecideResult {
  ok: boolean;
  /** One line for the dialog: where it was saved, that it was discarded, or why not. */
  message: string;
}

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
   * The owning app tab → service worker: the recording needs a decision from the human (the call
   * ended, the share ended); open the stop dialog. The service worker also opens it on a toolbar
   * click while `recording` or `stopped`.
   */
  | { type: 'ask-to-save' }
  /**
   * The stop dialog → the owning app tab: which recording is this about? Answered with a
   * PendingInfo, or undefined when nothing is recording or waiting (the dialog then closes).
   */
  | { type: 'query-pending' }
  /**
   * The stop dialog or a library row → the owning app tab: the human decided. `save` stops the
   * recording if it still runs and exports it to the folder from Settings; `save-as` the same
   * into the folder whose handle the sender stored under `export:<id>` first (handles cannot
   * travel in a message); `discard` stops it and deletes it. Answered with a DecideResult once the
   * export (or the deletion) is done.
   */
  | { type: 'decide'; id: string; action: Decision }
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
  | { type: 'adapter-diagnostic'; platform: Platform; at: number; message: string }
  /**
   * Content script → app tab: the call this tab was in has ended (Meet: the participant tiles
   * went away and stayed away). The app tab asks the human what to do with the recording; the
   * recording itself goes on until they answer, so a rejoin loses nothing.
   */
  | { type: 'call-ended'; platform: Platform; at: number };

export type AppStatus = 'idle' | RecordingStatus;

/** Fire-and-forget send. Resolves to undefined when nobody is listening. */
export function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}
