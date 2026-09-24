import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeActivity } from './activity.ts';

test('first observation is never active', () => {
  const a = new ChangeActivity(700);
  assert.equal(a.observe('x', 'l0', 0), false);
});

test('a change is active for the window, then fades', () => {
  const a = new ChangeActivity(700);
  a.observe('x', 'l0', 0);
  assert.equal(a.observe('x', 'l2', 250), true);
  assert.equal(a.observe('x', 'l2', 500), true);
  assert.equal(a.observe('x', 'l2', 950), true);
  assert.equal(a.observe('x', 'l2', 951), false);
});

test('continuous changes keep it active; keys are independent', () => {
  const a = new ChangeActivity(700);
  a.observe('x', 'l0', 0);
  a.observe('y', 'l0', 0);
  for (let t = 250; t <= 3000; t += 250) {
    assert.equal(a.observe('x', t % 500 ? 'l1' : 'l3', t), true);
    assert.equal(a.observe('y', 'l0', t), false);
  }
});

test('forget resets a key', () => {
  const a = new ChangeActivity(700);
  a.observe('x', 'l0', 0);
  a.observe('x', 'l1', 100);
  a.forget('x');
  assert.equal(a.observe('x', 'l2', 200), false);
});
