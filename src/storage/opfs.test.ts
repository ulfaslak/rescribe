import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isExportableArtifact, isMediaFile } from './opfs.ts';

describe('OPFS file classes', () => {
  it('raw media is the video and the PCM channels only', () => {
    for (const n of ['video.mp4', 'video.webm', 'mic.pcm', 'display.pcm'])
      assert.equal(isMediaFile(n), true, n);
    for (const n of ['events.jsonl', 'transcript.md', 'video.mp4.crswap', 'recording.mp4'])
      assert.equal(isMediaFile(n), false, n);
  });

  it('exportable artifacts exclude media, the events log, the segments cache and swap files', () => {
    for (const n of ['transcript.md', 'transcript.json', 'meta.json'])
      assert.equal(isExportableArtifact(n), true, n);
    for (const n of [
      'video.mp4',
      'display.pcm',
      'events.jsonl',
      'segments.mic.json',
      'segments.display.json',
      'transcript.md.crswap',
      'meta.json.crswap',
    ])
      assert.equal(isExportableArtifact(n), false, n);
  });
});
