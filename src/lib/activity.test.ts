import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeActivity } from './activity.ts';

test('one lone change is not activity; two within the window are', () => {
  const a = new ChangeActivity(700);
  a.touch('x', 1000);
  assert.equal(a.isActive('x', 1000), false);
  assert.equal(a.isActive('x', 1300), false);
  a.touch('x', 1400);
  assert.equal(a.isActive('x', 1400), true);
  assert.equal(a.startedAt('x'), 1000);
});

test('activity ends one window after the last change; lastChangeAt is the true end', () => {
  const a = new ChangeActivity(700);
  a.touch('x', 0);
  a.touch('x', 100);
  a.touch('x', 600);
  assert.equal(a.isActive('x', 1300), true);
  assert.equal(a.isActive('x', 1301), false);
  assert.equal(a.lastChangeAt('x'), 600);
});

test('a change after a long silence starts a new run', () => {
  const a = new ChangeActivity(700);
  a.touch('x', 0);
  a.touch('x', 100);
  a.touch('x', 5000);
  assert.equal(a.isActive('x', 5000), false);
  assert.equal(a.startedAt('x'), 5000);
  a.touch('x', 5200);
  assert.equal(a.isActive('x', 5200), true);
  assert.equal(a.startedAt('x'), 5000);
});

test('observe() derives changes from value differences; first sighting is a baseline', () => {
  const a = new ChangeActivity(700);
  assert.equal(a.observe('x', 'l0', 0), false);
  assert.equal(a.observe('x', 'l0', 250), false);
  assert.equal(a.observe('x', 'l2', 500), false);
  assert.equal(a.observe('x', 'l3', 750), true);
  assert.equal(a.startedAt('x'), 500);
  assert.equal(a.observe('x', 'l3', 1000), true);
  assert.equal(a.observe('x', 'l3', 1451), false);
  assert.equal(a.lastChangeAt('x'), 750);
});

test('keys are independent and forget resets', () => {
  const a = new ChangeActivity(700);
  a.touch('x', 0);
  a.touch('x', 100);
  assert.equal(a.isActive('y', 100), false);
  assert.equal(a.startedAt('y'), undefined);
  a.forget('x');
  assert.equal(a.isActive('x', 100), false);
  assert.equal(a.lastChangeAt('x'), undefined);
});

test('a lone change after a run does not move the end of the run', () => {
  // Seen in the two-person live check 2026-09-24: a stop stamped at the lone change (25.55 s)
  // instead of the true end of speech, then a start at the same instant.
  const a = new ChangeActivity(700);
  a.touch('x', 0);
  a.touch('x', 100);
  a.touch('x', 200);
  a.touch('x', 1000); // lone change, new run
  assert.equal(a.isActive('x', 1100), false);
  assert.equal(a.activeUntil('x'), 200);
  assert.equal(a.lastChangeAt('x'), 1000);
  a.touch('x', 1300); // second change: the new run is active from its first change
  assert.equal(a.isActive('x', 1300), true);
  assert.equal(a.startedAt('x'), 1000);
  assert.equal(a.activeUntil('x'), 1300);
});

test('activeUntil is undefined before any activity', () => {
  const a = new ChangeActivity(700);
  assert.equal(a.activeUntil('x'), undefined);
  a.touch('x', 0);
  assert.equal(a.activeUntil('x'), undefined);
});
