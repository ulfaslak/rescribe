import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateName, renderPathTemplate, sanitizeSegment, uniqueName } from './pathtemplate.ts';

// Local time on purpose: the export folder is named in the human's time zone.
const startedAt = new Date(2026, 8, 24, 14, 5, 9).getTime();

describe('renderPathTemplate', () => {
  it('renders the default template', () => {
    assert.deepEqual(
      renderPathTemplate('{date} {time} {title}', { startedAt, title: 'Weekly sync' }),
      ['2026-09-24 14-05 Weekly sync'],
    );
  });

  it('zero-pads and uses local time', () => {
    const at = new Date(2026, 0, 3, 7, 4).getTime();
    assert.deepEqual(renderPathTemplate('{date}_{time}', { startedAt: at, title: 'x' }), [
      '2026-01-03_07-04',
    ]);
  });

  it('nests on / in the template, never on / in the title', () => {
    assert.deepEqual(
      renderPathTemplate('{date}/{time} {title}', { startedAt, title: 'Q3 / Planning' }),
      ['2026-09-24', '14-05 Q3 - Planning'],
    );
  });

  it('strips illegal characters from tab titles', () => {
    assert.deepEqual(renderPathTemplate('{title}', { startedAt, title: 'Meet: "a" <b> | c?*' }), [
      'Meet- -a- -b- - c--',
    ]);
  });

  it('falls back when the title is empty or only illegal', () => {
    assert.deepEqual(renderPathTemplate('{title}', { startedAt, title: '' }), ['Recording']);
    assert.deepEqual(renderPathTemplate('{title}', { startedAt, title: '...' }), ['Recording']);
  });

  it('falls back to the default shape when the template renders to nothing', () => {
    assert.deepEqual(renderPathTemplate('', { startedAt, title: 'T' }), ['2026-09-24 14-05 T']);
    assert.deepEqual(renderPathTemplate('///', { startedAt, title: 'T' }), ['2026-09-24 14-05 T']);
  });

  it('leaves unknown tokens literal', () => {
    assert.deepEqual(renderPathTemplate('{foo} {title}', { startedAt, title: 'T' }), ['{foo} T']);
  });
});

describe('sanitizeSegment', () => {
  it('trims dots and spaces at the edges, collapses whitespace', () => {
    assert.equal(sanitizeSegment('  . a  b .  '), 'a b');
  });
  it('caps the length without leaving a trailing space', () => {
    const s = sanitizeSegment('ab '.repeat(100));
    assert.ok(s.length <= 200);
    assert.notEqual(s.at(-1), ' ');
  });
  it('replaces control characters', () => {
    assert.equal(sanitizeSegment('a\u0000b\tc'), 'a-b-c');
  });
});

describe('uniqueName', () => {
  it('returns the base when free', () => {
    assert.equal(uniqueName('x', new Set()), 'x');
  });
  it('suffixes from (2) upward, skipping taken suffixes', () => {
    assert.equal(uniqueName('x', new Set(['x'])), 'x (2)');
    assert.equal(uniqueName('x', new Set(['x', 'x (2)', 'x (3)'])), 'x (4)');
  });
  it('candidateName is the sequence uniqueName walks', () => {
    assert.equal(candidateName('x', 1), 'x');
    assert.equal(candidateName('x', 2), 'x (2)');
  });
});

/** True when the string has no lone surrogate (encodeURIComponent throws on one). */
const wellFormed = (s: string): boolean => {
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
};

describe('sanitizeSegment: file-system limits', () => {
  it('caps by UTF-8 bytes on a code-point boundary', () => {
    const title = '会議'.repeat(100); // 600 bytes
    const s = sanitizeSegment(title);
    assert.ok(new TextEncoder().encode(s).length <= 200, 'under the byte cap');
    assert.equal(s.length % 2, 0, 'whole characters');
    assert.ok(s.startsWith('会議会議'));
  });
  it('never splits a surrogate pair', () => {
    const s = sanitizeSegment('a'.repeat(199) + '😀' + 'b'.repeat(10));
    assert.ok(wellFormed(s));
    assert.equal(s, 'a'.repeat(199), 'the emoji did not fit in the last byte');
    const t = sanitizeSegment('a'.repeat(196) + '😀' + 'b'.repeat(10));
    assert.ok(wellFormed(t));
    assert.equal(t, 'a'.repeat(196) + '😀');
  });
  it('escapes Windows reserved device names', () => {
    for (const name of ['CON', 'con', 'NUL', 'com1', 'LPT9', 'aux.txt', 'PRN.log']) {
      const s = sanitizeSegment(name);
      assert.equal(s, `_${name}`, name);
    }
    assert.equal(sanitizeSegment('console'), 'console');
    assert.equal(sanitizeSegment('com10'), 'com10');
  });
});
