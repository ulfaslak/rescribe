import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  channelLabel,
  formatRemaining,
  overallFraction,
  planSteps,
  ProgressTracker,
  stepOf,
  summaryLine,
  type PipelineProgress,
  type PlanInput,
} from './progress.ts';

const both: PlanInput = {
  channels: [
    { channel: 'mic', cached: false },
    { channel: 'display', cached: false },
  ],
  model: true,
  exportFiles: true,
  myName: 'Ulf',
};

const cached: PlanInput = {
  ...both,
  channels: [
    { channel: 'mic', cached: true },
    { channel: 'display', cached: true },
  ],
};

/** Implementation words that must never reach the human (issue #31). */
const FORBIDDEN = /\b(mic|display|regions?)\b/i;

function everyText(p: PipelineProgress): string[] {
  return [p.message, summaryLine(p), ...p.steps.flatMap((s) => [s.label, s.detail ?? ''])];
}

describe('planSteps', () => {
  it('lists the model, the two channels as people, who said what and the files, in the pipeline order', () => {
    const steps = planSteps(both);
    assert.deepEqual(
      steps.map((s) => [s.kind, s.label, s.state]),
      [
        ['model', 'Speech model', 'pending'],
        ['channel', 'Ulf’s microphone', 'pending'],
        ['channel', 'The call', 'pending'],
        ['attribute', 'Who said what', 'pending'],
        ['export', 'Transcript files', 'pending'],
      ],
    );
  });

  it('names the microphone "Your microphone" on the default name, and after the human otherwise', () => {
    assert.equal(channelLabel('mic', 'Me'), 'Your microphone');
    assert.equal(channelLabel('mic', ''), 'Your microphone');
    assert.equal(channelLabel('mic', '  '), 'Your microphone');
    assert.equal(channelLabel('mic', 'Ulf'), 'Ulf’s microphone');
    assert.equal(channelLabel('display', 'Ulf'), 'The call');
  });

  it('marks a cached channel done before the job begins, and plans no model step when nothing is transcribed', () => {
    const steps = planSteps(cached);
    assert.deepEqual(
      steps.map((s) => [s.kind, s.state, s.cached ?? false]),
      [
        ['channel', 'done', true],
        ['channel', 'done', true],
        ['attribute', 'pending', false],
        ['export', 'pending', false],
      ],
    );
    assert.equal(steps[0]!.detail, 'kept from the last run');
  });

  it('omits the model step when it is loaded, the files step without an export path, and a channel with nothing on disk', () => {
    const steps = planSteps({
      channels: [{ channel: 'display', cached: false }],
      model: false,
      exportFiles: false,
      myName: 'Me',
    });
    assert.deepEqual(
      steps.map((s) => s.kind),
      ['channel', 'attribute'],
    );
  });
});

describe('overallFraction', () => {
  it('weights each step by its usual cost and reaches 1 only when every step is done', () => {
    const steps = planSteps(both);
    assert.equal(overallFraction(steps), 0);
    steps[0]!.state = 'done';
    steps[1]!.state = 'running';
    steps[1]!.fraction = 0.5;
    // model 0.3 + half a channel 0.5, over 0.3 + 1 + 1 + 0.05 + 0.05.
    assert.ok(Math.abs(overallFraction(steps) - 0.8 / 2.4) < 1e-9);
    for (const s of steps) s.state = 'done';
    assert.equal(overallFraction(steps), 1);
  });

  it('gives a cached channel no weight, so a re-run from the cache moves on the last two steps', () => {
    const steps = planSteps(cached);
    assert.equal(overallFraction(steps), 0);
    steps[2]!.state = 'done';
    steps[3]!.state = 'running';
    assert.equal(overallFraction(steps), 0.5);
  });
});

describe('ProgressTracker', () => {
  const t0 = 1_000_000;
  const region = (
    loaded: number,
    total: number,
    voicedDoneS: number,
    voicedTotalS: number,
    positionS?: number,
  ) => ({
    phase: 'transcribe' as const,
    loaded,
    total,
    voicedDoneS,
    voicedTotalS,
    ...(positionS !== undefined ? { positionS, lengthS: 2110 } : {}),
  });

  it('walks the plan: the model, each channel in turn, who said what, the files; the step count never changes; no implementation word reaches the human', () => {
    const t = new ProgressTracker(both, t0);
    const seen: PipelineProgress[] = [];
    const emit = (p: PipelineProgress) => {
      seen.push(p);
      for (const text of everyText(p)) assert.doesNotMatch(text, FORBIDDEN, JSON.stringify(p));
    };
    emit(t.snapshot('queued', t0)); // 0
    t.startChannel('mic');
    emit(t.snapshot('transcribe', t0 + 5)); // 1: the audio is being read
    // The model: two files, one bar over both. The channel waits behind it.
    t.report('mic', { phase: 'download', loaded: 0, total: 0 }, t0 + 10);
    emit(t.snapshot('download', t0 + 10)); // 2
    t.report('mic', { phase: 'download', loaded: 100e6, total: 600e6, file: 'a/enc' }, t0 + 20);
    emit(t.snapshot('download', t0 + 20)); // 3
    t.report('mic', { phase: 'download', loaded: 600e6, total: 600e6, file: 'a/enc' }, t0 + 30);
    emit(t.snapshot('download', t0 + 30)); // 4: the first file done, the next not started
    t.report('mic', { phase: 'download', loaded: 50e6, total: 100e6, file: 'a/dec' }, t0 + 40);
    emit(t.snapshot('download', t0 + 40)); // 5
    t.report('mic', { phase: 'load', loaded: 0, total: 1 }, t0 + 50);
    emit(t.snapshot('load', t0 + 50)); // 6
    // The microphone: three regions, 60 voiced seconds.
    t.report('mic', region(0, 3, 0, 60, 12), t0 + 1000);
    emit(t.snapshot('transcribe', t0 + 1000)); // 7
    t.report('mic', region(2, 3, 45, 60, 1092), t0 + 11_000);
    emit(t.snapshot('transcribe', t0 + 11_000)); // 8
    t.report('mic', region(3, 3, 60, 60), t0 + 15_000);
    t.finishChannel('mic', t0 + 15_000);
    t.startChannel('display');
    emit(t.snapshot('transcribe', t0 + 15_000)); // 9
    // The call: the model is loaded now, the job starts at its regions.
    t.report('display', region(0, 2, 0, 40, 3), t0 + 16_000);
    emit(t.snapshot('transcribe', t0 + 16_000)); // 10
    t.report('display', region(2, 2, 40, 40), t0 + 26_000);
    t.finishChannel('display', t0 + 26_000);
    t.begin('attribute');
    emit(t.snapshot('attribute', t0 + 26_100)); // 11
    t.begin('export');
    emit(t.snapshot('export', t0 + 26_200)); // 12
    t.finish();
    emit(t.snapshot('done', t0 + 26_300, 'Transcribed.')); // 13

    const counts = new Set(seen.map((p) => p.steps.length));
    assert.deepEqual([...counts], [5]);
    assert.deepEqual(
      seen.map((p) => p.message),
      [
        'Waiting to transcribe…',
        'Transcribing Ulf’s microphone',
        'Downloading the speech model',
        'Downloading the speech model',
        'Downloading the speech model',
        'Downloading the speech model',
        'Loading the speech model',
        'Transcribing Ulf’s microphone',
        'Transcribing Ulf’s microphone',
        'Transcribing the call',
        'Transcribing the call',
        'Working out who said what',
        'Writing the transcript files',
        'Transcribed.',
      ],
    );
    // Reading the audio: the channel runs without a share.
    assert.deepEqual(stepOf(seen[1]!), { index: 2, count: 5 });
    assert.equal(seen[1]!.fraction, undefined);
    // The download: the model runs and the channel waits; one count over both files, in MB, and
    // no share (the total grows as each file starts: a share would fall at the boundary).
    assert.deepEqual(stepOf(seen[2]!), { index: 1, count: 5 });
    assert.equal(seen[2]!.steps[1]!.state, 'pending');
    assert.equal(seen[2]!.steps[0]!.detail, undefined);
    assert.equal(seen[3]!.steps[0]!.detail, '100 of 600 MB');
    assert.equal(seen[4]!.steps[0]!.detail, '600 of 600 MB');
    assert.equal(seen[5]!.steps[0]!.detail, '650 of 700 MB');
    for (const i of [2, 3, 4, 5]) assert.equal(seen[i]!.fraction, undefined, `download ${i}`);
    assert.equal(seen[6]!.fraction, 1);
    assert.equal(seen[6]!.steps[0]!.detail, 'loading');
    assert.ok(Math.abs(seen[6]!.overall - 0.3 / 2.4) < 1e-9);
    // The microphone at its second region: the step's share by voiced seconds, the position in
    // the recording, and where the whole job stands.
    const mid = seen[8]!;
    assert.equal(mid.channel, 'mic');
    assert.equal(mid.steps[0]!.state, 'done');
    assert.equal(mid.fraction, 0.75);
    assert.equal(mid.steps[1]!.detail, 'at 18:12 of 35:10');
    assert.deepEqual(stepOf(mid), { index: 2, count: 5 });
    assert.ok(Math.abs(mid.overall - (0.3 + 0.75) / 2.4) < 1e-9, String(mid.overall));
    assert.equal(mid.startedAt, t0);
    // Its pace: 45 voiced seconds in 10 s; 15 s to go on this step. The call's speech is not
    // measured yet, so the estimate covers this step only.
    assert.deepEqual(mid.remaining, { seconds: 3, scope: 'step' });
    // Between the channels: the microphone is done, the call runs without a share or an
    // estimate yet.
    assert.deepEqual(
      seen[9]!.steps.map((s) => s.state),
      ['done', 'done', 'running', 'pending', 'pending'],
    );
    assert.equal(seen[9]!.fraction, undefined);
    assert.equal(seen[9]!.remaining, undefined);
    // The call's first region: no pace of its own yet, the microphone's (60 s in 14 s) is used,
    // and with no channel behind it the estimate is the job's.
    const call = seen[10]!;
    assert.equal(call.channel, 'display');
    assert.deepEqual(call.remaining, { seconds: Math.round(40 / (60 / 14)), scope: 'job' });
    // The last two steps, then everything done.
    assert.deepEqual(
      seen[11]!.steps.map((s) => s.state),
      ['done', 'done', 'done', 'running', 'pending'],
    );
    assert.equal(seen[11]!.remaining, undefined);
    assert.deepEqual(
      seen[13]!.steps.map((s) => s.state),
      ['done', 'done', 'done', 'done', 'done'],
    );
    assert.equal(seen[13]!.overall, 1);
    assert.equal(summaryLine(seen[13]!), 'Transcribed.');
    // Never backwards.
    for (let i = 1; i < seen.length; i++)
      assert.ok(seen[i]!.overall >= seen[i - 1]!.overall - 1e-9, `overall fell at ${i}`);
    // A snapshot is a copy: the tracker moving on does not change what a listener kept.
    assert.equal(seen[7]!.steps[1]!.state, 'running');
  });

  it('a failed run ends where it stopped: no full share, no step in the line', () => {
    const t = new ProgressTracker({ ...both, model: false }, t0);
    t.startChannel('mic');
    t.report('mic', region(1, 2, 30, 60, 100), t0);
    const p = t.snapshot('done', t0 + 10, 'Transcription failed: boom');
    assert.ok(p.overall < 1, String(p.overall));
    assert.equal(summaryLine(p), 'Transcription failed: boom');
  });

  it('shows no time left before a channel has been recognised for a while', () => {
    const t = new ProgressTracker(both, t0);
    t.report('mic', { phase: 'download', loaded: 1, total: 2, file: 'x' }, t0 + 10);
    assert.equal(t.snapshot('download', t0 + 10).remaining, undefined);
    t.report('mic', region(1, 4, 10, 40), t0 + 100);
    assert.equal(t.snapshot('transcribe', t0 + 2000).remaining, undefined);
    assert.equal(t.snapshot('transcribe', t0 + 6000).remaining?.scope, 'step');
  });

  it('a files step the plan did not have is added when the export begins', () => {
    const t = new ProgressTracker({ ...both, exportFiles: false }, t0);
    assert.equal(t.steps.length, 4);
    t.begin('export');
    const p = t.snapshot('export', t0);
    assert.deepEqual(stepOf(p), { index: 5, count: 5 });
    assert.equal(p.message, 'Writing the transcript files');
  });

  it('adds the model step on the spot when the worker fetches one the plan did not expect', () => {
    const t = new ProgressTracker({ ...both, model: false }, t0);
    assert.equal(t.steps.length, 4);
    t.startChannel('mic');
    t.report('mic', { phase: 'load', loaded: 0, total: 1 }, t0);
    assert.deepEqual(
      t.steps.map((s) => [s.kind, s.state]),
      [
        ['model', 'running'],
        ['channel', 'pending'],
        ['channel', 'pending'],
        ['attribute', 'pending'],
        ['export', 'pending'],
      ],
    );
    assert.equal(t.snapshot('load', t0).message, 'Loading the speech model');
  });

  it('a silent channel is done at once, and stays marked as silent', () => {
    const t = new ProgressTracker(both, t0);
    t.report('mic', { phase: 'transcribe', loaded: 0, total: 0 }, t0);
    const p = t.snapshot('transcribe', t0);
    assert.equal(p.fraction, 1);
    assert.equal(p.steps[1]!.detail, 'no speech found');
    t.finishChannel('mic', t0);
    assert.equal(t.snapshot('transcribe', t0).steps[1]!.detail, 'no speech found');
    t.finish();
    assert.equal(t.snapshot('done', t0).steps[1]!.detail, 'no speech found');
  });

  it('a run from the cache goes straight to who said what', () => {
    const t = new ProgressTracker(cached, t0);
    t.begin('attribute');
    const p = t.snapshot('attribute', t0);
    assert.equal(p.message, 'Working out who said what');
    assert.deepEqual(stepOf(p), { index: 3, count: 4 });
    assert.equal(p.steps[0]!.detail, 'kept from the last run');
    assert.equal(p.overall, 0);
  });
});

describe('summaryLine and formatRemaining', () => {
  it("one line with the step and the share, or the download's bytes", () => {
    const t = new ProgressTracker(both, 0);
    assert.equal(summaryLine(t.snapshot('queued', 0)), 'Waiting to transcribe…');
    t.report('mic', { phase: 'download', loaded: 120e6, total: 650e6, file: 'e' }, 0);
    assert.equal(
      summaryLine(t.snapshot('download', 0)),
      'Downloading the speech model · step 1 of 5 · 120 of 650 MB',
    );
    t.report(
      'mic',
      { phase: 'transcribe', loaded: 2, total: 2, voicedDoneS: 60, voicedTotalS: 60 },
      0,
    );
    t.finishChannel('mic', 0);
    t.report(
      'display',
      { phase: 'transcribe', loaded: 1, total: 2, voicedDoneS: 30, voicedTotalS: 60 },
      0,
    );
    // model 0.3 + the microphone 1 + half of the call 0.5, over 2.4.
    assert.equal(
      summaryLine(t.snapshot('transcribe', 0)),
      'Transcribing the call · step 3 of 5 · 75% overall',
    );
  });

  it('rounds the time left to what a person would say', () => {
    assert.equal(formatRemaining(0), 'under a minute left');
    assert.equal(formatRemaining(59), 'under a minute left');
    assert.equal(formatRemaining(60), 'about 1 min left');
    assert.equal(formatRemaining(150), 'about 3 min left');
    assert.equal(formatRemaining(3600), 'about 1 h left');
    assert.equal(formatRemaining(4800), 'about 1 h 20 min left');
    assert.equal(formatRemaining(150, 'step'), 'about 3 min left on this step');
    assert.equal(formatRemaining(10, 'step'), 'under a minute left on this step');
  });
});
