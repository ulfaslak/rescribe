// EBML, just enough for one job: give a MediaRecorder WebM the Duration its header lacks.
// Chrome's muxer writes a live stream (a Segment of unknown size, no Duration in Info, no Cues),
// so a browser plays the file as endless and a probe reports no length. `withDuration` rebuilds
// the bytes up to the end of Info with a Duration element added; everything after it (Tracks,
// the Clusters) is byte-identical and the caller copies it as it is. Nothing in the file refers
// to a byte offset (no SeekHead, no Cues), so growing Info moves nothing that matters. Pure: no
// DOM, no chrome.*.

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
/** Nanoseconds per timecode tick when Info does not say: a tick is a millisecond. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

interface Vint {
  value: number;
  length: number;
  /** A size whose value bits are all ones: "unknown", the live-stream marker. */
  unknown: boolean;
}

/** The variable-length integer at `pos`: an element id (marker bit kept) or a size (marker off). */
function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | undefined {
  const first = bytes[pos];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (pos + length > bytes.length) return undefined;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const b = bytes[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface Element {
  id: number;
  /** Offset of the id. */
  start: number;
  idLength: number;
  sizeLength: number;
  /** Offset of the payload. */
  dataStart: number;
  /** Payload length; meaningless when `unknown`. */
  size: number;
  unknown: boolean;
}

function readElement(bytes: Uint8Array, pos: number): Element | undefined {
  const id = readVint(bytes, pos, true);
  if (!id || id.length > 4) return undefined;
  const size = readVint(bytes, pos + id.length, false);
  if (!size) return undefined;
  return {
    id: id.value,
    start: pos,
    idLength: id.length,
    sizeLength: size.length,
    dataStart: pos + id.length + size.length,
    size: size.value,
    unknown: size.unknown,
  };
}

/** `value` as a size vint of exactly `length` bytes, or undefined when it does not fit. */
function encodeVint(value: number, length: number): Uint8Array | undefined {
  // All ones is reserved for "unknown", so the largest encodable value is one less.
  if (value < 0 || value > 2 ** (7 * length) - 2) return undefined;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function minimalVint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const v = encodeVint(value, length);
    if (v) return v;
  }
  throw new RangeError(`vint: ${value} does not fit`);
}

function readUint(bytes: Uint8Array, el: Element): number {
  let v = 0;
  for (let i = 0; i < el.size; i++) v = v * 256 + bytes[el.dataStart + i]!;
  return v;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export interface PatchedHead {
  /** Replaces the first `consumed` bytes of the file. */
  bytes: Uint8Array<ArrayBuffer>;
  consumed: number;
}

/**
 * The start of a WebM file with `durationMs` written into its Info element. `head` must reach
 * the end of Info (Chrome's is under 100 bytes in; a few kilobytes are plenty). Undefined when
 * the bytes are not a WebM whose Info can be found before the first Cluster, when Info already
 * carries a Duration, or when the duration is not a positive number: the caller then exports the
 * file as it is.
 */
export function withDuration(head: Uint8Array, durationMs: number): PatchedHead | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const ebml = readElement(head, 0);
  if (!ebml || ebml.id !== ID_EBML || ebml.unknown) return undefined;
  const segment = readElement(head, ebml.dataStart + ebml.size);
  if (!segment || segment.id !== ID_SEGMENT) return undefined;

  let info: Element | undefined;
  for (let pos = segment.dataStart; pos < head.length;) {
    const el = readElement(head, pos);
    if (!el || el.unknown || el.id === ID_CLUSTER) return undefined;
    if (el.id === ID_INFO) {
      info = el;
      break;
    }
    pos = el.dataStart + el.size;
  }
  if (!info) return undefined;
  const infoEnd = info.dataStart + info.size;
  if (infoEnd > head.length) return undefined;

  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  for (let pos = info.dataStart; pos < infoEnd;) {
    const el = readElement(head, pos);
    if (!el || el.unknown || el.dataStart + el.size > infoEnd) return undefined;
    if (el.id === ID_DURATION) return undefined;
    if (el.id === ID_TIMECODE_SCALE) timecodeScale = readUint(head, el);
    pos = el.dataStart + el.size;
  }
  if (timecodeScale <= 0) return undefined;

  // Duration: id 0x4489, size 8, a float64 in timecode ticks.
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / timecodeScale);

  const children = head.subarray(info.dataStart, infoEnd);
  const newInfo = concat(
    head.subarray(info.start, info.start + info.idLength),
    minimalVint(children.length + duration.length),
    children,
    duration,
  );
  const before = head.slice(0, info.start);
  if (!segment.unknown) {
    const grown = newInfo.length - (infoEnd - info.start);
    const resized = encodeVint(segment.size + grown, segment.sizeLength);
    if (!resized) return undefined;
    before.set(resized, segment.start + segment.idLength);
  }
  return { bytes: concat(before, newInfo), consumed: infoEnd };
}
