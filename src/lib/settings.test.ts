import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateSettings, toFrameRate } from './settings.ts';
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from './types.ts';

describe('migrateSettings', () => {
  it('drops the container an unversioned object carries, so the new default applies', () => {
    const out = migrateSettings({ container: 'mp4', myName: 'Ulf', pathTemplate: '{date}' });
    assert.equal(out.container, undefined);
    assert.equal(out.myName, 'Ulf');
    assert.equal(out.pathTemplate, '{date}');
    assert.equal(out.settingsVersion, SETTINGS_VERSION);
    assert.equal({ ...DEFAULT_SETTINGS, ...out }.container, 'webm');
  });

  it('keeps a container chosen at the current version', () => {
    const out = migrateSettings({ container: 'mp4', settingsVersion: SETTINGS_VERSION });
    assert.equal(out.container, 'mp4');
    assert.equal(out.settingsVersion, SETTINGS_VERSION);
  });

  it('stamps an empty store with the version and nothing else', () => {
    assert.deepEqual(migrateSettings({}), { settingsVersion: SETTINGS_VERSION });
  });

  it('normalises a stored frame rate or container that is not one of the offered values', () => {
    const odd = { frameRate: 15, container: 'avi', settingsVersion: SETTINGS_VERSION } as unknown;
    const out = migrateSettings(odd as Parameters<typeof migrateSettings>[0]);
    assert.equal(out.frameRate, DEFAULT_SETTINGS.frameRate);
    assert.equal(out.container, undefined);
    assert.equal({ ...DEFAULT_SETTINGS, ...out }.container, 'webm');
    const fine = migrateSettings({
      frameRate: 30,
      container: 'mp4',
      settingsVersion: SETTINGS_VERSION,
    });
    assert.equal(fine.frameRate, 30);
    assert.equal(fine.container, 'mp4');
  });
});

describe('toFrameRate', () => {
  it('accepts the offered rates as numbers or form strings', () => {
    assert.equal(toFrameRate(5), 5);
    assert.equal(toFrameRate('10'), 10);
    assert.equal(toFrameRate('30'), 30);
  });

  it('falls back to the default for anything else', () => {
    for (const v of [undefined, null, '', 'fast', 7, 60, NaN])
      assert.equal(toFrameRate(v), DEFAULT_SETTINGS.frameRate, String(v));
  });
});
