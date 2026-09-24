// Pins INVARIANTS "The mic channel and the display channel are never mixed before transcription"
// on the graph topology: every tap has exactly one input, its own channel's source in the tap
// context, and no edge crosses from the mix context (where the mixer lives) into the tap context.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIXER, SPEAKERS, planGraph, type GraphPlan } from './graph.ts';
import type { ChannelId } from '../lib/types.ts';

const byId = (plan: GraphPlan) => new Map(plan.nodes.map((n) => [n.id, n]));

function assertTapsIsolated(plan: GraphPlan): void {
  const nodes = byId(plan);
  for (const tap of plan.nodes.filter((n) => n.kind === 'tap')) {
    const inputs = plan.edges.filter((e) => e.to === tap.id);
    assert.equal(inputs.length, 1, `${tap.id} has exactly one input`);
    const src = nodes.get(inputs[0]!.from)!;
    assert.equal(src.kind, 'source');
    assert.equal(src.ctx, 'tap');
    assert.equal(src.channel, tap.channel, `${tap.id} is fed by its own channel`);
    assert.equal(plan.edges.filter((e) => e.from === tap.id).length, 0, `${tap.id} has no outputs`);
  }
  for (const e of plan.edges) {
    assert.equal(
      nodes.get(e.from)!.ctx,
      nodes.get(e.to)!.ctx,
      `edge ${e.from} → ${e.to} stays in one context`,
    );
  }
  assert.equal(nodes.get(MIXER)!.ctx, 'mix');
  assert.equal(
    plan.edges.filter((e) => e.from === MIXER).length,
    0,
    'the mixer feeds nothing inside the graph (only the MediaRecorder track)',
  );
}

describe('planGraph', () => {
  for (const channels of [['mic', 'display'], ['display'], ['mic']] as ChannelId[][]) {
    it(`isolates the taps for ${channels.join('+')}`, () => {
      assertTapsIsolated(planGraph(channels));
      assertTapsIsolated(planGraph(channels, ['display']));
    });
  }

  it('creates one tap and one mixer input per channel', () => {
    const plan = planGraph(['mic', 'display']);
    assert.equal(plan.nodes.filter((n) => n.kind === 'tap').length, 2);
    assert.equal(plan.edges.filter((e) => e.to === MIXER).length, 2);
    assert.equal(plan.nodes.filter((n) => n.kind === 'mixer').length, 1);
  });

  it('plays the display channel back only when asked, never the mic', () => {
    const silent = planGraph(['mic', 'display']);
    assert.ok(!silent.nodes.some((n) => n.id === SPEAKERS));
    const playback = planGraph(['mic', 'display'], ['display']);
    const toSpeakers = playback.edges.filter((e) => e.to === SPEAKERS).map((e) => e.from);
    assert.deepEqual(toSpeakers, ['mix-source:display']);
    const feedback = planGraph(['mic', 'display'], ['mic']);
    assert.equal(feedback.edges.filter((e) => e.to === SPEAKERS).length, 0);
  });
});
