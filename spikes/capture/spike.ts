// Spike: getDisplayMedia (tab + audio) and a separate mic at once → mixed → MediaRecorder MP4,
// while a worker appends the chunks to OPFS with a sync access handle. See spikes/README.md.
declare global {
  interface Window {
    __spike?: Record<string, unknown>;
  }
}

const out = (o: Record<string, unknown>): void => {
  window.__spike = o;
  document.getElementById('out')!.textContent = JSON.stringify(
    { ...o, base64: undefined },
    null,
    1,
  );
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rms(an: AnalyserNode): number {
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

async function run(): Promise<Record<string, unknown>> {
  const r: Record<string, unknown> = {};
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  r.displayTracks = display.getTracks().map((t) => `${t.kind}:${t.label}`);
  r.micTracks = mic.getTracks().map((t) => `${t.kind}:${t.label}`);

  const ctx = new AudioContext();
  const mix = ctx.createMediaStreamDestination();
  const analysers: Record<string, AnalyserNode> = {};
  for (const [name, stream] of [
    ['display', display],
    ['mic', mic],
  ] as const) {
    if (!stream.getAudioTracks().length) continue;
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser();
    src.connect(an);
    src.connect(mix);
    analysers[name] = an;
  }
  r.audioContextState = ctx.state;

  const mime = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
  r.mimeSupported = MediaRecorder.isTypeSupported(mime);
  const recStream = new MediaStream([...display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
  const rec = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
  r.mimeUsed = rec.mimeType;

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const closed = new Promise<number>((resolve) => {
    worker.onmessage = (e: MessageEvent<{ type: string; bytes: number }>) => {
      if (e.data.type === 'closed') resolve(e.data.bytes);
    };
  });
  const chunks: Blob[] = [];
  let pending = Promise.resolve();
  rec.ondataavailable = (e) => {
    chunks.push(e.data);
    pending = pending.then(async () => {
      const buf = await e.data.arrayBuffer();
      worker.postMessage({ type: 'append', buf }, [buf]);
    });
  };
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));

  const peak: Record<string, number> = {};
  rec.start(500);
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) {
    for (const [name, an] of Object.entries(analysers))
      peak[name] = Math.max(peak[name] ?? 0, rms(an));
    await sleep(100);
  }
  rec.stop();
  await stopped;
  await pending;
  worker.postMessage({ type: 'close' });
  r.opfsBytes = await closed;

  const blob = new Blob(chunks, { type: mime });
  r.size = blob.size;
  r.chunks = chunks.length;
  r.peakRms = peak;
  // Hand the file to the test as a real download (byte-exact), not through evaluate().
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'spike-capture.mp4';
  document.body.append(a);
  a.click();
  for (const t of [...display.getTracks(), ...mic.getTracks()]) t.stop();
  await ctx.close();
  return r;
}

document.getElementById('go')!.addEventListener('click', () => {
  run()
    .then(out)
    .catch((e) => out({ error: String(e), stack: (e as Error).stack }));
});
