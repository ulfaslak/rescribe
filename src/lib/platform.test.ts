import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { platformOf } from './platform.ts';

test('every page a content script runs on is a platform (manifest and platform.ts agree)', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
  ) as {
    content_scripts: { matches: string[] }[];
  };
  const matches = manifest.content_scripts.flatMap((cs) => cs.matches);
  assert.ok(matches.length > 0);
  for (const m of matches) {
    // `https://host/*` → a URL on that host.
    assert.ok(platformOf(m.replace(/\*$/, 'x')), `${m} is not a platform`);
  }
});

test('a Meet call is meet', () => {
  assert.equal(platformOf('https://meet.google.com/abc-defg-hij'), 'meet');
  assert.equal(platformOf('https://meet.google.com/'), 'meet');
  assert.equal(platformOf('https://meet.google.com/abc-defg-hij?authuser=1#x'), 'meet');
});

test('anything else is not a platform', () => {
  assert.equal(platformOf('https://www.youtube.com/watch?v=x'), undefined);
  assert.equal(platformOf('https://meet.google.com.evil.example/'), undefined);
  assert.equal(platformOf('https://evil.example/meet.google.com/'), undefined);
  assert.equal(platformOf('http://meet.google.com/abc'), undefined);
  assert.equal(platformOf('chrome-extension://abc/app/app.html'), undefined);
  assert.equal(platformOf('chrome://newtab/'), undefined);
});

test('no url, or not a url', () => {
  assert.equal(platformOf(undefined), undefined);
  assert.equal(platformOf(''), undefined);
  assert.equal(platformOf('not a url'), undefined);
});
