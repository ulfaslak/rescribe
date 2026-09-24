// Getting the streams. Three entry points, one shape out: the toolbar path (a tab-capture stream
// id from the service worker), the picker path (getDisplayMedia from the app tab, needs a user
// gesture) and the microphone. DECISIONS § Capture.
import type { Source } from '../lib/types.ts';

export interface Captured {
  stream: MediaStream;
  source: Source;
  /** True for tab capture: Chrome mutes the captured tab for the human, so the recorder must play
   * the display channel back through the speakers. */
  needsPlayback: boolean;
}

/** The human closed Chrome's picker without choosing anything. Not an error. */
export class CaptureCancelled extends Error {
  constructor() {
    super('Capture cancelled');
    this.name = 'CaptureCancelled';
  }
}

/** Toolbar path: consume the stream id `chrome.tabCapture.getMediaStreamId` produced. */
export async function captureTab(streamId: string, title?: string): Promise<Captured> {
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return {
    stream,
    source: { channel: 'display', kind: 'tab', label: title },
    needsPlayback: true,
  };
}

/** Picker path. Throws CaptureCancelled when the picker is dismissed. */
export async function captureDisplay(): Promise<Captured> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === 'AbortError' || name === 'NotAllowedError') throw new CaptureCancelled();
    throw err;
  }
  const video = stream.getVideoTracks()[0];
  const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  const kind = surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'screen';
  return {
    stream,
    source: { channel: 'display', kind, label: video?.label || undefined },
    needsPlayback: false,
  };
}

/** The microphone, or undefined when denied or absent (the recording goes on without it). */
export async function captureMic(): Promise<Captured | undefined> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stream.getAudioTracks()[0];
    return {
      stream,
      source: { channel: 'mic', kind: 'microphone', label: track?.label || undefined },
      needsPlayback: false,
    };
  } catch (err) {
    console.warn('[rescribe] microphone unavailable', err);
    return undefined;
  }
}

export function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}
