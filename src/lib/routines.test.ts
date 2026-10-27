import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_VARIABLES, renderPrompt, type PromptVariable } from './routines.ts';

const values = Object.fromEntries(PROMPT_VARIABLES.map((v) => [v.name, `<${v.name}>`])) as Record<
  PromptVariable,
  string
>;

test('renderPrompt fills in each variable wherever and as often as it is written', () => {
  assert.equal(
    renderPrompt('{{title}} on {{date}}, {{ time }}; again {{title}}.', values),
    '<title> on <date>, <time>; again <title>.',
  );
});

test('renderPrompt leaves what is not a variable as written', () => {
  assert.equal(
    renderPrompt('{{nope}} {title} {{Title}} {{ title }x} {"a": {"b": 1}}', values),
    '{{nope}} {title} {{Title}} {{ title }x} {"a": {"b": 1}}',
  );
});

test("renderPrompt puts a value in as it is, a title's $& and $1 included", () => {
  assert.equal(
    renderPrompt('Notes: {{title}}', { ...values, title: 'Q$& $1 $$ review' }),
    'Notes: Q$& $1 $$ review',
  );
});
