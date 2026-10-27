// The Workflows section of the app tab (DECISIONS § Workflows): the workflows the native host
// keeps (`~/.rescribe/workflows/`), each with Edit and Delete, and New workflow. The editor, one
// at a time, stands in for the workflow's row (a new one at the top): its name, its one line, the
// runner, the folder, and the prompt Claude Code is given, with the variables it can use and what
// the runner puts around it. A save or a delete goes to the host, which checks it; then the list
// is asked again and `onChange` lets the rows' pickers and the stop dialog's list catch up.
import { PROMPT_VARIABLES, type RunnerInfo, type Workflow } from '../lib/routines.ts';
import { confirmButton } from '../ui/confirm.ts';
import { deleteWorkflow, listWorkflows, saveWorkflow, type WorkflowList } from '../ui/routines.ts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let list: WorkflowList | undefined;
/** Why there is no list: the host is missing or said no. */
let listError: string | undefined;
/** The workflow being edited: its id, '' for a new one, undefined when the editor is closed. */
let editing: string | undefined;
let changed: () => void = () => undefined;

function status(text: string, isError = false): void {
  const el = $<HTMLElement>('#workflows-status');
  el.textContent = text;
  el.className = `hint${isError ? ' error' : ''}`;
}

/** `/Users/ulf/Documents/notes` → `~/Documents/notes`. */
function tilde(dir: string): string {
  const home = list?.home;
  if (!home) return dir;
  if (dir === home) return '~';
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

function runnerOf(id: string): RunnerInfo | undefined {
  return list?.runners.find((r) => r.id === id);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * Ask the host again and show what it says. An editor opened while the host was being asked is
 * left as it is: the answer neither rebuilds it (what was typed would go) nor, when it is a
 * failure, takes away the list it stands in; the next render, when it closes, shows the news.
 */
async function load(): Promise<void> {
  try {
    list = await listWorkflows();
    listError = undefined;
  } catch (err) {
    if (editing === undefined) list = undefined;
    listError = describe(err);
  }
  if (editing === undefined) render();
}

function render(): void {
  const note = $<HTMLElement>('#workflows-note');
  note.hidden = listError === undefined;
  note.textContent = listError ? `No workflows: ${listError}` : '';
  const newButton = $<HTMLButtonElement>('#new-workflow');
  newButton.disabled = !list || list.runners.length === 0 || editing !== undefined;
  $<HTMLElement>('#workflows-empty').hidden =
    !list || list.workflows.length > 0 || editing !== undefined;
  const items: HTMLLIElement[] = [];
  if (list && editing === '') items.push(editor(blank()));
  for (const w of list?.workflows ?? []) items.push(w.id === editing ? editor(w) : row(w));
  $<HTMLUListElement>('#workflows-list').replaceChildren(...items);
  if (editing !== undefined)
    $<HTMLUListElement>('#workflows-list')
      .querySelector<HTMLInputElement>('input[name="label"]')
      ?.focus();
}

/** A new workflow: the first runner's prompt and folder to start from. */
function blank(): Workflow {
  const r = list?.runners[0];
  return {
    id: '',
    label: '',
    runner: r?.id ?? '',
    folder: r?.defaultFolder ?? '',
    prompt: r?.prompt ?? '',
  };
}

function open(id: string): void {
  editing = id;
  status('');
  render();
}

function row(w: Workflow): HTMLLIElement {
  const li = el('li', 'workflow-item');
  li.dataset['id'] = w.id;
  const head = el('div', 'workflow-head');
  head.append(el('span', 'title', w.label));
  const runner = runnerOf(w.runner);
  const badge = el(
    'span',
    'runner',
    `runs with ${runner?.label ?? `${w.runner}, which is not in this Rescribe`}`,
  );
  badge.title = runner?.description ?? 'Its runner is not in the clone the host runs from.';
  head.append(badge);
  li.append(head);
  if (w.description) li.append(el('div', 'hint', w.description));
  li.append(el('div', 'path', tilde(w.folder)));
  const actions = el('div', 'actions');
  const edit = el('button', 'edit', 'Edit');
  edit.type = 'button';
  edit.disabled = editing !== undefined;
  edit.addEventListener('click', () => open(w.id));
  const del = confirmButton('Delete', `Delete "${w.label}"?`, 'delete', () => void remove(w));
  del.disabled = editing !== undefined;
  actions.append(edit, del);
  li.append(actions);
  return li;
}

async function remove(w: Workflow): Promise<void> {
  status(`Deleting "${w.label}"…`);
  try {
    await deleteWorkflow(w.id);
  } catch (err) {
    status(`"${w.label}" was not deleted: ${describe(err)}`, true);
    return;
  }
  await load();
  changed();
  status(
    `Deleted "${w.label}". Its files are in ~/.rescribe/workflows/.trash/ should you want it back.`,
  );
}

/** A labelled field: the caption, the control, and a hint under it. */
function field(caption: string, control: HTMLElement, hint?: HTMLElement): HTMLLabelElement {
  const label = el('label', '');
  label.append(el('span', '', caption), control);
  if (hint) label.append(hint);
  return label;
}

function textInput(name: string, value: string, max: number): HTMLInputElement {
  const input = el('input', '');
  input.name = name;
  input.value = value;
  input.maxLength = max;
  input.autocomplete = 'off';
  return input;
}

/** What the runner puts around the prompt, shown as it is: Claude Code gets all of it. */
function wrapping(r: RunnerInfo | undefined): HTMLDetailsElement | undefined {
  if (!r?.before && !r?.after) return undefined;
  const details = el('details', 'wrap');
  details.append(
    el('summary', '', `${r.label} puts text before and after your prompt`),
    el('p', 'hint', 'Before it:'),
    el('pre', 'before', r.before?.trim() || '(nothing)'),
    el('p', 'hint', 'After it:'),
    el('pre', 'after', r.after?.trim() || '(nothing)'),
  );
  return details;
}

function editor(w: Workflow): HTMLLIElement {
  const li = el('li', 'workflow-item editing');
  li.dataset['id'] = w.id;
  const form = el('form', 'workflow-editor');
  form.noValidate = true;

  const label = textInput('label', w.label, 80);
  label.placeholder = 'Meeting notes';
  const description = textInput('description', w.description ?? '', 200);
  description.placeholder = 'Notes from the call into my notes folder';
  const runner = el('select', '');
  runner.name = 'runner';
  for (const r of list?.runners ?? []) {
    const option = el('option', '', r.label);
    option.value = r.id;
    runner.append(option);
  }
  if (!runnerOf(w.runner) && w.runner) {
    const option = el('option', '', `${w.runner} (not in this Rescribe)`);
    option.value = w.runner;
    runner.append(option);
  }
  runner.value = w.runner;
  const runnerHint = el('small', 'hint');
  const folder = textInput('folder', tilde(w.folder), 1000);
  folder.className = 'mono';
  folder.placeholder = '~/Documents/notes';
  folder.spellcheck = false;
  const folderHint = el('small', 'hint');

  const prompt = el('textarea', '');
  prompt.name = 'prompt';
  prompt.value = w.prompt;
  prompt.rows = 16;
  prompt.spellcheck = false;
  prompt.setAttribute('aria-label', 'Prompt');
  const variables = el('div', 'variables');
  variables.append(el('span', 'hint', 'Insert:'));
  for (const v of PROMPT_VARIABLES) {
    const b = el('button', 'variable', `{{${v.name}}}`);
    b.type = 'button';
    b.title = `{{${v.name}}}: ${v.means}`;
    b.dataset['variable'] = v.name;
    b.addEventListener('click', () => {
      prompt.focus();
      prompt.setRangeText(`{{${v.name}}}`, prompt.selectionStart, prompt.selectionEnd, 'end');
      prompt.dispatchEvent(new Event('input'));
    });
    variables.append(b);
  }
  const legend = el(
    'small',
    'hint',
    'Each {{variable}} is filled in when a run starts, wherever it is and as often as it is written; hover one to see what it holds.',
  );
  const wrap = el('div', 'wrap-slot');
  const promptField = el('div', 'prompt-field');
  promptField.append(el('span', 'caption', 'Prompt'), variables, wrap, prompt, legend);

  // A new workflow follows the runner it is switched to while its prompt and folder are as that
  // runner gave them; what the human wrote stays.
  let shown = runnerOf(w.runner);
  const showRunner = (): void => {
    const r = runnerOf(runner.value);
    runnerHint.textContent = r?.description ?? 'Its runner is not in the clone the host runs from.';
    folderHint.textContent = r?.folderHint ?? '';
    wrap.replaceChildren(...[wrapping(r)].filter((d) => d !== undefined));
    if (!w.id && shown && r && shown !== r) {
      if (prompt.value === shown.prompt) prompt.value = r.prompt;
      if (folder.value === (shown.defaultFolder ?? '')) folder.value = r.defaultFolder ?? '';
    }
    shown = r;
  };
  runner.addEventListener('change', showRunner);
  showRunner();

  const current = (): Workflow => ({
    id: w.id,
    label: label.value,
    ...(description.value.trim() ? { description: description.value } : {}),
    runner: runner.value,
    folder: folder.value,
    prompt: prompt.value,
  });
  const initial = JSON.stringify(current());
  const dirty = (): boolean => JSON.stringify(current()) !== initial;

  const save = el('button', 'save primary', w.id ? 'Save' : 'Add workflow');
  save.type = 'submit';
  const cancel = el('button', 'cancel', 'Cancel');
  cancel.type = 'button';
  // Changes are not thrown away on one click: Cancel asks first when there are any.
  let armed = false;
  cancel.addEventListener('click', () => {
    if (dirty() && !armed) {
      armed = true;
      cancel.textContent = 'Discard changes?';
      cancel.classList.add('armed');
      return;
    }
    editing = undefined;
    status('');
    render();
  });
  form.addEventListener('input', () => {
    if (!armed) return;
    armed = false;
    cancel.textContent = 'Cancel';
    cancel.classList.remove('armed');
  });
  const formStatus = el('p', 'hint form-status');
  formStatus.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  actions.append(save, cancel);

  form.append(
    field('Name', label),
    field(
      'What it does, in a line',
      description,
      el('small', 'hint', 'Shown under its button when a recording stops.'),
    ),
    field('Runs with', runner, runnerHint),
    field('Folder', folder, folderHint),
    promptField,
    actions,
    formStatus,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });

  async function submit(): Promise<void> {
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    formStatus.className = 'hint form-status';
    formStatus.textContent = 'Saving…';
    let saved: Workflow;
    try {
      saved = await saveWorkflow(current());
    } catch (err) {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
      formStatus.className = 'hint form-status error';
      formStatus.textContent = describe(err);
      return;
    }
    editing = undefined;
    await load();
    changed();
    status(`Saved "${saved.label}".`);
  }

  li.append(form);
  return li;
}

/**
 * Ask the host for the workflows and show them; `onChange` runs after every save and delete.
 * Called once the app tab is up; a host that is missing leaves the section saying so.
 */
export async function initWorkflows(onChange: () => void): Promise<void> {
  changed = onChange;
  $<HTMLButtonElement>('#new-workflow').addEventListener('click', () => open(''));
  await load();
}

/** Ask again: a workflow file edited by hand, or the host installed since. */
export function reloadWorkflows(): Promise<void> {
  if (editing !== undefined) return Promise.resolve();
  return load();
}
