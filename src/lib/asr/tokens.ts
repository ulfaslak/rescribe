// Whisper's token side, pure: the byte-level BPE vocabulary turned back into text, the guard
// against a decoder stuck repeating itself, and words placed in time for an engine that gives no
// word timings. Node-tested in tokens.test.ts.
import type { Word } from '../types.ts';

/** GPT-2's byte ↔ printable-character table that Whisper's vocabulary is written in. */
function byteDecoder(): Map<string, number> {
  const bytes: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) bytes.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bytes.push(b);
  for (let b = 0xae; b <= 0xff; b++) bytes.push(b);
  const chars = bytes.slice();
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      chars.push(256 + extra++);
    }
  }
  const out = new Map<string, number>();
  bytes.forEach((b, i) => out.set(String.fromCodePoint(chars[i]!), b));
  return out;
}

export class WhisperVocab {
  private readonly idToToken: string[] = [];
  private readonly tokenToId = new Map<string, number>();
  private readonly bytes = byteDecoder();
  /** `<|endoftext|>`: the end of a transcript, and every id from it up is a special token. */
  readonly eot: number;

  /** From the repo's `vocab.json` and `added_tokens.json` (token → id). */
  constructor(vocab: Record<string, number>, added: Record<string, number>) {
    for (const [token, id] of [...Object.entries(vocab), ...Object.entries(added)]) {
      this.idToToken[id] = token;
      this.tokenToId.set(token, id);
    }
    this.eot = this.id('<|endoftext|>');
  }

  /** The id of a token such as `<|da|>`; throws when the vocabulary has no such token. */
  id(token: string): number {
    const id = this.tokenToId.get(token);
    if (id === undefined) throw new Error(`Whisper vocabulary has no ${token}`);
    return id;
  }

  /** Text tokens to text: special tokens are dropped, bytes reassembled as UTF-8. */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      if (id >= this.eot) continue;
      const token = this.idToToken[id];
      if (token === undefined) continue;
      for (const ch of token) {
        const b = this.bytes.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes)).trim();
  }
}

/**
 * Where a decoder caught in a loop started repeating: the length to keep, or undefined when the
 * tail is not a loop. A loop is the same block of 1–`maxPeriod` tokens repeated back to back at
 * the end, `minRepeats` times or more (a single token needs twice that). The first copy stays.
 */
export function loopStart(
  tokens: readonly number[],
  minRepeats = 4,
  maxPeriod = 16,
): number | undefined {
  for (let p = 1; p <= maxPeriod; p++) {
    const need = p === 1 ? minRepeats * 2 : minRepeats;
    if (tokens.length < p * need) break;
    let reps = 1;
    let at = tokens.length - p;
    while (at - p >= 0 && sameBlock(tokens, at - p, at, p)) {
      reps++;
      at -= p;
    }
    if (reps >= need) return at + p;
  }
  return undefined;
}

function sameBlock(tokens: readonly number[], a: number, b: number, p: number): boolean {
  for (let i = 0; i < p; i++) if (tokens[a + i] !== tokens[b + i]) return false;
  return true;
}

/**
 * Words with times for an engine that gives text only: the region's span shared out by character
 * count (a space counts as one), so a long word takes longer. Rough by construction; nothing
 * downstream reads word times for attribution (DECISIONS § Speech recognition).
 */
export function spreadWords(text: string, durationS: number): Word[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || durationS <= 0) return [];
  const total = parts.reduce((sum, w) => sum + w.length, 0) + parts.length - 1;
  const words: Word[] = [];
  let chars = 0;
  for (const text of parts) {
    const start = (chars / total) * durationS;
    chars += text.length;
    const end = (chars / total) * durationS;
    chars += 1;
    words.push({ text, start, end });
  }
  return words;
}
