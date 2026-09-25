// The audio graph of a recording, as a plan (pure, unit-tested) and its realisation.
//
// Two AudioContexts. The tap context runs at 16 kHz and hosts one AudioWorklet tap per channel,
// each fed by its own MediaStreamAudioSourceNode; Chrome resamples the track to the context rate,
// so the tap sees 16 kHz mono and writes Int16 blocks. The mix context runs at the device rate and
// hosts the mixer (a MediaStreamAudioDestinationNode) that feeds the MediaRecorder's audio track,
// plus optional playback of the display channel to the speakers (tab capture mutes the captured
// tab for the human; getDisplayMedia does not). Web Audio refuses to connect nodes across contexts,
// so nothing in the mix context can reach a tap: INVARIANTS "never mixed before transcription".
// `planGraph` is the topology; `graph.test.ts` pins the properties above on it.
import type { ChannelId } from '../lib/types.ts';

export type GraphContext = 'mix' | 'tap';
export type NodeKind = 'source' | 'tap' | 'mixer' | 'speakers';

export interface GraphNode {
  id: string;
  ctx: GraphContext;
  kind: NodeKind;
  /** For sources and taps: the channel whose track they carry. */
  channel?: ChannelId;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphPlan {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const TAP_PROCESSOR = 'rescribe-tap';
export const TAP_SAMPLE_RATE = 16000;

export function tapSourceId(c: ChannelId): string {
  return `tap-source:${c}`;
}
export function tapId(c: ChannelId): string {
  return `tap:${c}`;
}
export function mixSourceId(c: ChannelId): string {
  return `mix-source:${c}`;
}
export const MIXER = 'mixer';
export const SPEAKERS = 'speakers';

/**
 * @param channels the channels that have an audio track
 * @param playback channels to also play through the speakers (only ever `display`, for tab capture)
 */
export function planGraph(channels: ChannelId[], playback: ChannelId[] = []): GraphPlan {
  const nodes: GraphNode[] = [{ id: MIXER, ctx: 'mix', kind: 'mixer' }];
  const edges: GraphEdge[] = [];
  if (playback.length > 0) nodes.push({ id: SPEAKERS, ctx: 'mix', kind: 'speakers' });
  for (const channel of channels) {
    nodes.push(
      { id: tapSourceId(channel), ctx: 'tap', kind: 'source', channel },
      { id: tapId(channel), ctx: 'tap', kind: 'tap', channel },
      { id: mixSourceId(channel), ctx: 'mix', kind: 'source', channel },
    );
    edges.push({ from: tapSourceId(channel), to: tapId(channel) });
    edges.push({ from: mixSourceId(channel), to: MIXER });
    if (playback.includes(channel) && channel !== 'mic')
      edges.push({ from: mixSourceId(channel), to: SPEAKERS });
  }
  return { nodes, edges };
}

export interface BuiltGraph {
  mixer: MediaStreamAudioDestinationNode;
  taps: Map<ChannelId, AudioWorkletNode>;
  /** Every node created, for disconnecting on stop. */
  nodes: AudioNode[];
}

/** Realise a plan. `tapCtx.audioWorklet` must already have `TAP_PROCESSOR` registered. */
export function buildGraph(
  plan: GraphPlan,
  mixCtx: AudioContext,
  tapCtx: AudioContext,
  tracks: ReadonlyMap<ChannelId, MediaStreamTrack>,
): BuiltGraph {
  const built = new Map<string, AudioNode>();
  const taps = new Map<ChannelId, AudioWorkletNode>();
  let mixer: MediaStreamAudioDestinationNode | undefined;
  for (const n of plan.nodes) {
    const ctx = n.ctx === 'mix' ? mixCtx : tapCtx;
    let node: AudioNode;
    switch (n.kind) {
      case 'source': {
        const track = n.channel && tracks.get(n.channel);
        if (!track) throw new Error(`graph: no track for ${n.id}`);
        node = ctx.createMediaStreamSource(new MediaStream([track]));
        break;
      }
      case 'tap': {
        const tap = new AudioWorkletNode(ctx, TAP_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        if (n.channel) taps.set(n.channel, tap);
        node = tap;
        break;
      }
      case 'mixer':
        // Mono: the channels are speech, and a stereo mix doubled the video file's audio for
        // nothing (DECISIONS § Capture).
        mixer = new MediaStreamAudioDestinationNode(ctx, {
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node = mixer;
        break;
      case 'speakers':
        node = ctx.destination;
        break;
    }
    built.set(n.id, node);
  }
  for (const e of plan.edges) {
    const from = built.get(e.from);
    const to = built.get(e.to);
    if (!from || !to) throw new Error(`graph: dangling edge ${e.from} → ${e.to}`);
    from.connect(to);
  }
  if (!mixer) throw new Error('graph: no mixer');
  return { mixer, taps, nodes: [...built.values()] };
}
