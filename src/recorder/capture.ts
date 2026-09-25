// Getting the streams. Three entry points, one shape out: the toolbar path (a tab-capture stream
// id from the service worker), the picker path (getDisplayMedia from the app tab, needs a user
// gesture) and the microphone. DECISIONS § Capture.
import type { FrameRate, Source } from '../lib/types.ts';

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

/**
 * Toolbar path: consume the stream id `chrome.tabCapture.getMediaStreamId` produced. The frame
 * rate is capped at the source (Settings, 5 fps by default): MediaRecorder encodes every frame it
 * is given, so this is where the file size and the encoder's work are decided.
 */
export async function captureTab(
  streamId: string,
  frameRate: FrameRate,
  title?: string,
): Promise<Captured> {
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: frameRate,
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

/** Picker path, the frame rate capped as above. Throws CaptureCancelled when the picker is dismissed. */
export async function captureDisplay(frameRate: FrameRate): Promise<Captured> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: frameRate, max: frameRate } },
      audio: true,
    });
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

/**
 * The microphone, or undefined when denied or absent (the recording goes on without it). With a
 * `deviceId` (Settings, chosen in the start dialog) that device; when it is gone (unplugged since
 * it was chosen), the default device rather than none: the recording's source label says which
 * one it got.
 */
export async function captureMic(deviceId?: string): Promise<Captured | undefined> {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const open = (id?: string): Promise<MediaStream> =>
    navigator.mediaDevices.getUserMedia({
      audio: id ? { ...audio, deviceId: { exact: id } } : audio,
    });
  let stream: MediaStream;
  try {
    stream = await open(deviceId || undefined);
  } catch (err) {
    // Only a device that is gone falls back; a denied prompt must not prompt a second time.
    const name = (err as DOMException).name;
    if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) {
      console.warn('[rescribe] microphone unavailable', err);
      return undefined;
    }
    console.warn('[rescribe] the chosen microphone is gone; the default one instead', err);
    try {
      stream = await open();
    } catch (err2) {
      console.warn('[rescribe] microphone unavailable', err2);
      return undefined;
    }
  }
  const track = stream.getAudioTracks()[0];
  return {
    stream,
    source: { channel: 'mic', kind: 'microphone', label: track?.label || undefined },
    needsPlayback: false,
  };
}

export function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}
