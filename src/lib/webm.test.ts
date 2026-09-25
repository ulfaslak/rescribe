import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDuration } from './webm.ts';

const bytes = (...parts: Array<number[] | Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
};

/** An element with a minimal size vint (payloads here are under 16 kB). */
const el = (id: number[], payload: number[] | Uint8Array): Uint8Array => {
  const size =
    payload.length < 127
      ? [0x80 | payload.length]
      : [0x40 | (payload.length >> 8), payload.length & 0xff];
  return bytes(id, size, payload);
};
/** An element of unknown size, as Chrome writes the Segment and every Cluster. */
const live = (id: number[], payload: number[] | Uint8Array): Uint8Array =>
  bytes(id, [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], payload);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const float64 = (v: number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return [...b];
};
const durationEl = (ticks: number): Uint8Array => bytes([0x44, 0x89, 0x88], float64(ticks));

// The first bytes of a WebM Chrome's MediaRecorder wrote (AV1, 2026-09-25), up to the first
// Cluster: EBML header, Segment (unknown size), Info { TimecodeScale 1e6, MuxingApp, WritingApp },
// Tracks, then Cluster (unknown size).
const EBML_HEADER = bytes([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
  0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04,
  0x42, 0x85, 0x81, 0x02,
]);
const TIMECODE_SCALE_1MS = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]);
const APPS = bytes(el([0x4d, 0x80], ascii('Chrome')), el([0x57, 0x41], ascii('Chrome')));
const INFO_CHILDREN = bytes(TIMECODE_SCALE_1MS, APPS);
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const TRACKS = el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x81, 0x00, 0xd7, 0x81, 0x01]);
const CLUSTER = live([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00, 0xa3, 0x81, 0x00]);

const chromeHead = (info = el(INFO_ID, INFO_CHILDREN)): Uint8Array =>
  bytes(EBML_HEADER, live([0x18, 0x53, 0x80, 0x67], bytes(info, TRACKS, CLUSTER)));

describe('withDuration', () => {
  it("adds a Duration to Chrome's Info and leaves everything after Info alone", () => {
    const head = chromeHead();
    const out = withDuration(head, 24_849);
    assert.ok(out);
    // Up to Info: identical. Info: same id, size grown by 11, same children, then Duration.
    const infoStart = EBML_HEADER.length + 4 + 8;
    assert.equal(out.consumed, infoStart + 4 + 1 + INFO_CHILDREN.length);
    assert.deepEqual(
      out.bytes,
      bytes(
        head.subarray(0, infoStart),
        INFO_ID,
        [0x80 | (INFO_CHILDREN.length + 11)],
        INFO_CHILDREN,
        durationEl(24_849),
      ),
    );
    assert.deepEqual(head.subarray(out.consumed), bytes(TRACKS, CLUSTER));
  });

  it('scales the duration by the TimecodeScale in Info', () => {
    const half = el([0x2a, 0xd7, 0xb1], [0x07, 0xa1, 0x20]); // 500 000 ns per tick
    const out = withDuration(chromeHead(el(INFO_ID, bytes(half, APPS))), 1000);
    assert.ok(out);
    assert.deepEqual(out.bytes.subarray(-11), durationEl(2000));
  });

  it('assumes a millisecond tick when Info has no TimecodeScale', () => {
    const out = withDuration(chromeHead(el(INFO_ID, APPS)), 3_470_800);
    assert.ok(out);
    assert.deepEqual(out.bytes.subarray(-11), durationEl(3_470_800));
  });

  it('widens the size vint when the grown Info no longer fits one byte', () => {
    const children = el([0xec], new Uint8Array(120)); // a 122-byte Void; 133 with the Duration
    const out = withDuration(chromeHead(el(INFO_ID, children)), 10);
    assert.ok(out);
    const infoStart = EBML_HEADER.length + 4 + 8;
    assert.deepEqual([...out.bytes.subarray(infoStart + 4, infoStart + 6)], [0x40, 133]);
    assert.deepEqual(out.bytes.subarray(infoStart + 6, infoStart + 6 + 122), children);
    assert.equal(out.bytes.length, infoStart + 6 + 122 + 11);
  });

  it('grows a known Segment size along with Info', () => {
    const body = bytes(el(INFO_ID, INFO_CHILDREN), TRACKS);
    const head = bytes(
      EBML_HEADER,
      [0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0, 0, 0, 0, body.length],
      body,
    );
    const out = withDuration(head, 10);
    assert.ok(out);
    assert.deepEqual(
      [...out.bytes.subarray(EBML_HEADER.length + 4, EBML_HEADER.length + 12)],
      [0x01, 0, 0, 0, 0, 0, 0, body.length + 11],
    );
  });

  it('leaves a file that already has a Duration alone', () => {
    const info = el(INFO_ID, bytes(TIMECODE_SCALE_1MS, durationEl(5), APPS));
    assert.equal(withDuration(chromeHead(info), 10), undefined);
  });

  it('gives up when the head ends before Info does', () => {
    const head = chromeHead();
    const infoStart = EBML_HEADER.length + 4 + 8;
    assert.equal(withDuration(head.subarray(0, infoStart + 10), 10), undefined);
    assert.equal(withDuration(head.subarray(0, infoStart + 2), 10), undefined);
    assert.equal(withDuration(head.subarray(0, 20), 10), undefined);
  });

  it('gives up when a Cluster comes before any Info, or the bytes are not EBML', () => {
    const noInfo = bytes(EBML_HEADER, live([0x18, 0x53, 0x80, 0x67], bytes(TRACKS, CLUSTER)));
    assert.equal(withDuration(noInfo, 10), undefined);
    assert.equal(withDuration(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), 10), undefined);
    assert.equal(withDuration(new Uint8Array(0), 10), undefined);
    // An MP4: `ftyp` box.
    assert.equal(withDuration(bytes([0, 0, 0, 0x18], ascii('ftypisom')), 10), undefined);
  });

  it('gives up on a duration that is not a positive number', () => {
    for (const d of [0, -1, NaN, Infinity]) assert.equal(withDuration(chromeHead(), d), undefined);
  });
});
