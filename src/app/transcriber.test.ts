import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber, type WorkerLike } from './transcriber.ts';
import type { WorkerRequest, WorkerResponse } from '../workers/transcribe.ts';

/** A worker that records what it was sent (transferring for real) and replies when told to. */
class FakeWorker implements WorkerLike {
  posted: WorkerRequest[] = [];
  terminated = false;
  throwOnPost = false;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;

  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.throwOnPost) throw new DOMException('detached', 'DataCloneError');
    this.posted.push(structuredClone(message, { transfer }) as WorkerRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const transcriber = new Transcriber({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { workers, transcriber, opts: { model: 'm', backend: 'wasm' as const } };
}

const pcm = () => Int16Array.from([1, 2, 3, 4]);
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: Error };
const settled = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (v) => ({ status: 'fulfilled' as const, value: v }),
    (e: Error) => ({ status: 'rejected' as const, reason: e }),
  );
/** The rejection message, or 'fulfilled' so a wrongly resolved promise fails a match. */
const reason = (r: Settled<unknown>) => (r.status === 'rejected' ? String(r.reason) : 'fulfilled');

test('jobs are posted and transferred at call time, before earlier jobs finish', () => {
  const { workers, transcriber, opts } = setup();
  const a = pcm();
  const b = pcm();
  void transcriber.transcribeChannel(a, 'mic', opts).catch(() => undefined);
  void transcriber.transcribeChannel(b, 'display', opts).catch(() => undefined);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.posted.length, 2);
  assert.equal(a.byteLength, 0, 'first buffer transferred immediately');
  assert.equal(b.byteLength, 0, 'second buffer transferred immediately, not after job 1');
  assert.deepEqual(
    workers[0]!.posted.map((r) => [r.jobId, r.channel]),
    [
      ['job-1', 'mic'],
      ['job-2', 'display'],
    ],
  );
  transcriber.dispose();
});

test('results and progress are routed by job id; the worker is reused', async () => {
  const { workers, transcriber, opts } = setup();
  const seen: string[] = [];
  const p1 = transcriber.transcribeChannel(pcm(), 'mic', { ...opts, offsetS: 5 }, (p) =>
    seen.push(`1:${p.phase}`),
  );
  const p2 = transcriber.transcribeChannel(pcm(), 'display', opts, (p) =>
    seen.push(`2:${p.phase}`),
  );
  const w = workers[0]!;
  assert.equal(w.posted[0]!.offsetS, 5);
  w.reply({ type: 'progress', jobId: 'job-1', phase: 'load', loaded: 0, total: 1 });
  w.reply({ type: 'progress', jobId: 'job-2', phase: 'transcribe', loaded: 0, total: 1 });
  w.reply({ type: 'progress', jobId: 'job-9', phase: 'transcribe', loaded: 0, total: 1 });
  const seg = { channel: 'mic' as const, start: 0, end: 1, text: 'hi' };
  w.reply({ type: 'result', jobId: 'job-2', segments: [], backend: 'wasm' });
  w.reply({ type: 'result', jobId: 'job-1', segments: [seg], backend: 'wasm' });
  assert.deepEqual(await p1, [seg]);
  assert.deepEqual(await p2, []);
  assert.deepEqual(seen, ['1:load', '2:transcribe']);
  assert.equal(workers.length, 1);
});

test('dispose rejects the active and the queued jobs, terminates, and refuses new jobs', async () => {
  const { workers, transcriber, opts } = setup();
  const p1 = settled(transcriber.transcribeChannel(pcm(), 'mic', opts));
  const p2 = settled(transcriber.transcribeChannel(pcm(), 'display', opts));
  transcriber.dispose();
  assert.equal(workers[0]!.terminated, true);
  assert.match(reason(await p1), /disposed/);
  assert.match(reason(await p2), /disposed/);
  const p3 = settled(transcriber.transcribeChannel(pcm(), 'mic', opts));
  assert.match(reason(await p3), /disposed/);
  assert.equal(workers.length, 1, 'no worker spawned after dispose');
});

test('a transcribe-stage error restarts the worker: the job and its queued siblings fail, the next job gets a fresh worker', async () => {
  const { workers, transcriber, opts } = setup();
  const p1 = settled(transcriber.transcribeChannel(pcm(), 'mic', opts));
  const p2 = settled(transcriber.transcribeChannel(pcm(), 'display', opts));
  workers[0]!.reply({ type: 'error', jobId: 'job-1', stage: 'transcribe', message: 'Aborted()' });
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.status, 'rejected');
  assert.match(reason(r1), /Aborted\(\)/);
  assert.equal(r2.status, 'rejected');
  assert.match(reason(r2), /restarted.*Aborted\(\)/);
  assert.equal(workers[0]!.terminated, true);
  const p3 = transcriber.transcribeChannel(pcm(), 'mic', opts);
  assert.equal(workers.length, 2, 'a fresh worker for the next job');
  workers[1]!.reply({ type: 'result', jobId: 'job-3', segments: [], backend: 'wasm' });
  assert.deepEqual(await p3, []);
});

test('a load-stage error fails only that job and keeps the worker', async () => {
  const { workers, transcriber, opts } = setup();
  const p1 = settled(
    transcriber.transcribeChannel(pcm(), 'mic', { model: 'nope', backend: 'wasm' }),
  );
  const p2 = transcriber.transcribeChannel(pcm(), 'display', opts);
  workers[0]!.reply({ type: 'error', jobId: 'job-1', stage: 'load', message: '401' });
  assert.equal((await p1).status, 'rejected');
  assert.equal(workers[0]!.terminated, false);
  workers[0]!.reply({ type: 'result', jobId: 'job-2', segments: [], backend: 'wasm' });
  assert.deepEqual(await p2, []);
  assert.equal(workers.length, 1);
});

test('a worker crash fails every pending job and the next job respawns', async () => {
  const { workers, transcriber, opts } = setup();
  const p1 = settled(transcriber.transcribeChannel(pcm(), 'mic', opts));
  const p2 = settled(transcriber.transcribeChannel(pcm(), 'display', opts));
  workers[0]!.crash('boom');
  assert.match(reason(await p1), /boom/);
  assert.match(reason(await p2), /boom/);
  assert.equal(workers[0]!.terminated, true);
  void transcriber.transcribeChannel(pcm(), 'mic', opts).catch(() => undefined);
  assert.equal(workers.length, 2);
  transcriber.dispose();
});

test('a postMessage that throws fails that job only and registers nothing', async () => {
  const { workers, transcriber, opts } = setup();
  void transcriber.transcribeChannel(pcm(), 'mic', opts).catch(() => undefined);
  workers[0]!.throwOnPost = true;
  const bad = settled(transcriber.transcribeChannel(pcm(), 'display', opts));
  assert.equal((await bad).status, 'rejected');
  workers[0]!.throwOnPost = false;
  const p3 = transcriber.transcribeChannel(pcm(), 'display', opts);
  assert.equal(workers[0]!.posted.length, 2);
  workers[0]!.reply({ type: 'result', jobId: 'job-3', segments: [], backend: 'wasm' });
  assert.deepEqual(await p3, []);
  transcriber.dispose();
});
