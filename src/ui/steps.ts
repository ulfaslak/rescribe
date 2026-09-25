// The transcription progress widget, shared by the recording's row in the library
// (app/library.ts) and the processing tab (progress/progress.ts): the job's steps in order with
// the running one marked, one segmented bar (a segment per step, as wide as the step's usual
// share of the work, so the whole job and the step read off the same line), and a line with
// where the running step is, the time elapsed and a rough time left. Renders a PipelineProgress
// (lib/progress.ts) as it comes and knows nothing of channels or regions. Styles in steps.css.
import { formatDuration } from '../lib/format.ts';
import {
  formatRemaining,
  runningIndex,
  stepOf,
  stepWeight,
  type PipelineProgress,
  type PipelineStep,
} from '../lib/progress.ts';

export interface StepsOptions {
  /** The steps as a column with the running step's detail on its line (the processing tab). */
  vertical?: boolean;
  /** Lead the foot line with the headline (the row, which has no headline of its own). */
  headline?: boolean;
  /** Epoch ms, for the time elapsed. */
  now?: number;
}

/** A segment narrower than this share of the bar is not visible; the tiny steps get this much. */
const MIN_SEGMENT = 0.08;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** What sits next to a step's label: a download's bytes, a channel's share, nothing when idle. */
function note(step: PipelineStep, vertical: boolean): string | undefined {
  if (step.state === 'running') {
    if (step.kind === 'model') return step.detail;
    if (step.fraction === undefined) return undefined;
    return vertical && step.detail
      ? `${percent(step.fraction)} · ${step.detail}`
      : percent(step.fraction);
  }
  // Done: what a kept or a silent channel has to say.
  if (step.state === 'done') return step.detail;
  return undefined;
}

function stepItem(step: PipelineStep, index: number, vertical: boolean): HTMLLIElement {
  const li = el('li', `step ${step.state}`);
  li.dataset['kind'] = step.kind;
  li.append(el('span', 'step-mark', step.state === 'done' ? '✓' : String(index + 1)));
  li.append(el('span', 'step-label', step.label));
  const n = note(step, vertical);
  if (n) li.append(el('span', 'step-note', n));
  return li;
}

function bar(steps: PipelineStep[], overall: number): HTMLDivElement {
  const b = el('div', 'steps-bar');
  b.setAttribute('role', 'progressbar');
  b.setAttribute('aria-label', 'Whole transcription');
  b.setAttribute('aria-valuemin', '0');
  b.setAttribute('aria-valuemax', '100');
  b.setAttribute('aria-valuenow', String(Math.round(overall * 100)));
  for (const step of steps) {
    const seg = el('span', `seg ${step.state}`);
    seg.style.flexGrow = String(Math.max(stepWeight(step), MIN_SEGMENT));
    if (step.state === 'running') {
      const fill = el('span', 'seg-fill');
      if (step.fraction === undefined) seg.classList.add('indeterminate');
      else fill.style.width = percent(step.fraction);
      seg.append(fill);
    }
    b.append(seg);
  }
  return b;
}

/** Update the elapsed time of every widget under `root` (a 1 s ticker between renders). */
export function tickElapsed(root: ParentNode, now = Date.now()): void {
  for (const e of root.querySelectorAll<HTMLElement>('.steps-elapsed[data-started-at]')) {
    const startedAt = Number(e.dataset['startedAt']);
    if (Number.isFinite(startedAt)) e.textContent = `${formatDuration(now - startedAt)} elapsed`;
  }
}

/** Render `p` into `root`, replacing what was there. */
export function renderSteps(root: HTMLElement, p: PipelineProgress, opts: StepsOptions = {}): void {
  const now = opts.now ?? Date.now();
  const vertical = opts.vertical ?? false;
  const box = el('div', `steps${vertical ? ' vertical' : ''}`);
  box.dataset['phase'] = p.phase;
  if (p.steps.length === 0) {
    // Queued, or a run with no plan: the headline alone.
    box.append(el('div', 'steps-headline', p.message));
    root.replaceChildren(box);
    return;
  }
  const list = el('ol', 'steps-list');
  p.steps.forEach((s, i) => list.append(stepItem(s, i, vertical)));
  box.append(list, bar(p.steps, p.overall));

  const foot = el('div', 'steps-foot');
  const at = stepOf(p);
  // The row has no headline of its own: its foot leads with the headline and the step. The
  // processing tab says both above the widget.
  if (opts.headline) {
    foot.append(el('span', 'steps-headline', p.message));
    if (at) foot.append(el('span', 'steps-step', `step ${at.index} of ${at.count}`));
  }
  const running = p.steps[runningIndex(p.steps)];
  if (!vertical && running?.kind === 'channel' && running.detail)
    foot.append(el('span', 'steps-where', running.detail));
  if (p.startedAt !== undefined && p.phase !== 'done') {
    const elapsed = el('span', 'steps-elapsed', `${formatDuration(now - p.startedAt)} elapsed`);
    elapsed.dataset['startedAt'] = String(p.startedAt);
    foot.append(elapsed);
  }
  if (p.remaining)
    foot.append(el('span', 'steps-left', formatRemaining(p.remaining.seconds, p.remaining.scope)));
  box.append(foot);
  root.replaceChildren(box);
}
