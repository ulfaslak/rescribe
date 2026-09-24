---
name: cleanse
description: DNA cleanse for Rescribe. Reviews AGENTS/DNA/ against itself and the code, sweeps the ledgers in AGENTS/ (DEFERRED, ENVIRONMENT_NOTES, LIVE_CHECKS, HUMAN_TODO, AGENT_MISTAKES), prunes redundant tests, fixes broken wiki links and section references, and closes straggler issues. Use when the user asks for a cleanse, a DNA review or a drift check, or says the docs no longer match the code.
---

# DNA Cleanse

When invoked, ask the human: **shallow or deep?**

A software project is like a living organism. It grows and changes over time, but its ideological core, its DNA, must remain self-consistent and coherent, otherwise cancer sets in and the project dies. A cleanse finds and fixes the inconsistencies and contradictions: inside `AGENTS/DNA/`, between the DNA and the code, and in the ledgers around it (`AGENTS/*.md`).

The DNA is the human's. A cleanse proposes; the human approves; only then is anything changed, through the ordinary worktree → PR cycle in CLAUDE.md. A change to a guardrail (CLAUDE.md, an existing DNA item) is always proposed on its own, never folded into a fix.

## The scan first (both)

From the repo root, on `main` with a clean tree:

```
node .claude/skills/cleanse/scan.mjs --verbose
```

It does the mechanical checks, so your reading goes to judgement. Hard findings (exit 1) are defects; soft findings are questions to answer from the code, never from the scan.

| Check | Kind |
|---|---|
| A `[[link]]` whose target file does not exist | hard |
| `DOC § "Heading"` or `DOC § Heading words` naming a section DOC does not have | hard |
| A `path/like/this` the docs name that is not on disk | hard |
| An entry of ARCHITECTURE's file structure that is not on disk | hard |
| A file on disk that ARCHITECTURE's file structure does not mention | soft |
| A `src/` file nothing imports that is not a bundle entry point | soft |
| A `planned` marker in the DNA (the marker goes in the PR that builds the part) | soft |
| A test title the docs quote that no test carries (a paraphrase, or a renamed test) | soft |
| A ledger entry missing a required field or tag; a `[learned]` naming no fix; an INVARIANTS entry past ~600 characters; an ENVIRONMENT_NOTES entry whose removal condition may have been met | soft |

## Shallow cleanse

Review the DNA documents against each other and glance at the implementation.

1. Read all of `AGENTS/DNA/`: [[ARCHITECTURE]], [[DECISIONS]], [[DEVELOPMENT]], [[INVARIANTS]], [[PRODUCT]].
2. Check internal consistency: do the files agree with each other? Contradictions, a fact stated in two places, a reference to something no other doc has?
3. Check each statement sits in the right file, by the table in CLAUDE.md: a choice in ARCHITECTURE, an invariant phrased as a decision, a feature described in INVARIANTS. Move it; never copy it.
4. Skim the implementation (the file tree, `src/manifest.json`, `scripts/build.mjs`, the key files) for anything obviously out of sync: a decision the code plainly violates, a `Settings` field the data model does not have, a claim in README § Use that PRODUCT's feature inventory does not back, and the reverse.
5. `npm run check` and `npm test` on `main`. Red is a finding, not a precondition.
6. The ledger sweep, below.

## Deep cleanse

Thorough review of the DNA against the full implementation.

1. Everything in the shallow cleanse.
2. Read every source file in `src/` and `e2e/` (skip `src/icons/`). For each, verify it follows [[DECISIONS]]: vanilla DOM, no framework; `.ts` import extensions; no TypeScript-only runtime syntax in `src/lib/` ([[DEVELOPMENT]] § Commands); the two audio channels apart until the transcript; no network beyond the model download; a worker's protocol typed in the worker's file; every export used somewhere (the scan sees files, you see exports).
3. **Invariant reality check.** For each entry in [[INVARIANTS]], open the mechanism it names and the test it says pins it. The mechanism must exist as described, and the test must fail when the mechanism is removed: read it, and when in doubt run it with the guard commented out, then restore. An entry that no longer matches the code is a bug in one of them; find out which before proposing a change.
4. **Manifest and layout reality check.** The counterpart of a database check in a project without a database: the prose against the artefacts the browser actually reads.
   - `src/manifest.json` against the code: every `chrome.*` API used has its permission and nothing is permitted that is not used; `content_scripts` matches `src/content/`; every command is handled in `background.ts`; no `host_permissions` ([[INVARIANTS]] § "No audio, video or transcript ever leaves the machine"); the COOP and COEP headers cross-origin isolation depends on.
   - The entry points in `scripts/build.mjs` against ARCHITECTURE's "each its own bundle" claims.
   - [[ARCHITECTURE]] § Storage against `src/storage/opfs.ts`, `store.ts`, `export.ts`, `src/lib/idb.ts` and `settings.ts`: OPFS paths and file names, IndexedDB database and store names, `chrome.storage.local` keys, the export layout.
   - [[ARCHITECTURE]] § "Data model" against `src/lib/types.ts`: fields, status values, `Settings`.
   - The message roster: `src/lib/messages.ts` against every `chrome.runtime.sendMessage` and `onMessage` handler; worker protocols in the worker file and nowhere else.
5. Orphaned code: the scan's file candidates, plus exports nothing imports, helpers in `e2e/helpers.ts` no spec calls, files in `e2e/fixtures/` nothing loads.
6. `npm run e2e` on `main` (the first run in a fresh worktree downloads the model: [[DEVELOPMENT]] § "The e2e harness").
7. For each issue found, consider whether a missing guardrail in `AGENTS/DNA/` or CLAUDE.md let it happen. If so, propose the guardrail; the human decides.
8. **Agent mistake review.** Read [[AGENT_MISTAKES]] and look for patterns: recurring categories, common root causes, a class of mistake that keeps happening. For each pattern:
   - Decide whether a workflow change (CLAUDE.md), a DNA line, or code (a helper, a type, a test pattern, a hook) would prevent it. Mechanical guards end patterns; prose rules rarely do.
   - Propose the change; implement it when the human approves.
   - Tag the entries it covers `[learned]` with a reference to what changed. The tag is strict: a `[learned]` with no reference is a tagging error.
   - Work the `[not codified]` backlog: each entry names what would have to be written.

   One-off errors with no pattern stay as they are; not every mistake needs a systemic fix.

## Ledger sweep (both)

The files beside the DNA in `AGENTS/` are ledgers, each with a removal rule. Check every entry against its rule.

- [[DEFERRED]]: resolved but not removed; a trigger that has fired; an entry no longer relevant. Each entry needs **What**, **Why deferred** and **Trigger**.
- [[ENVIRONMENT_NOTES]]: an entry whose removal condition has been met; a version or probe result the current environment contradicts.
- [[LIVE_CHECKS]]: an entry whose trigger fired long ago and is still waiting: list those for the human, the only one who can run them. Never run or remove one yourself. An entry naming code, a setting or a button that has moved or is gone: fix the entry.
- [[HUMAN_TODO]]: completed entries.
- [[AGENT_MISTAKES]]: the scan's tag and format findings (shallow); the pattern review above (deep).

## Test pruning (both)

After exploring the codebase (shallow: skimming, deep: reading every file), sanity-check the test files (`src/**/*.test.ts`, `e2e/*.spec.ts`) against the code you just saw. Flag or remove tests that are **completely redundant** by these criteria:

| # | Criterion | Action |
|---|---|---|
| 1 | **Shadowed by an e2e spec**: a unit test that mocks a browser API (MediaRecorder, OPFS, `chrome.*`) to assert what an e2e spec already asserts in the real browser | Remove |
| 2 | **Tests deleted or renamed code**: imports or references functions or modules that no longer exist (`npm run check` would already be red) | Remove |
| 3 | **Tautological**: asserts what the type system guarantees, with no runtime logic exercised | Remove |
| 4 | **Exact duplicate**: two `test` blocks assert the same input → output with no meaningful variation | Remove the duplicate |
| 5 | **Dead fixture**: a helper in `e2e/helpers.ts` or `e2e/fixtures.ts`, or a file in `e2e/fixtures/`, that nothing uses | Remove |

**Do not remove:**

- A test that [[INVARIANTS]] or [[AGENT_MISTAKES]] names as the pin of a mechanism or a fix. If it really is redundant, the entry points at its replacement in the same PR.
- Boundary and edge-case tests, even when an e2e covers the happy path of the same function. Boundary bugs in this codebase have been silent (AGENT_MISTAKES: the threshold compare on ms-derived seconds, the float seconds where the unit was frames).
- E2e specs: high-value by definition.
- A test that fakes a *collaborator* to test the client's own logic (`src/app/transcriber.test.ts` drives the client against a fake worker). Criterion 1 is about mocking the thing under test.
- Any test you are not confident about; flag it for the human instead.

The principles are in [[DEVELOPMENT]] § "Testing ideology".

## Broken links (both)

The scan lists the wiki links whose target does not exist and the `§` references to headings that are not there; fix them in place. Then read for what a script cannot see:

1. A plain-text reference to a DNA or ledger doc that should be a wiki link (`` `DECISIONS.md` `` or "see DECISIONS" instead of [[DECISIONS]]). Convert it. `DOC § Heading` without brackets is this repo's shorthand and stays.
2. A `§` reference that resolves to a heading but no longer means what the sentence says, because the section was rewritten.

## Issue hygiene (both)

`Closes #N` in a PR body closes its issue on merge, so most stay current on their own. This sweep catches the rest.

1. `gh issue list` on `ulfaslak/rescribe`. Skip anything labelled `eventually`: that is the backlog, not a straggler.
2. For each open issue with a claim comment (`🔨 Started work on this.`), check whether its PR merged: `gh issue view <N> --comments`, then `gh pr list --state merged --search "<title or branch>"`. Merged: `gh issue close <N> --comment "Merged in #<PR>."`. Not merged and quiet for a week: list it for the human; don't close it.
3. `git gtr list` for worktrees. **Never remove one.** CLAUDE.md forbids touching a worktree you did not create, and another session may own it. List the branches whose PR has merged and let the human decide.

## Output

Present every issue found (DNA inconsistencies, ledger entries to remove, test-pruning candidates, links, issues, worktrees) with the proposed fix for each, grouped by file, then let the human reply. If nothing is wrong, say so.

When the human approves, implement in a worktree like any other change: `git gtr new chore/cleanse-YYYY-MM-DD`, commit, push, `gh pr create` with the session footer, and the test-fix-learn cycle from CLAUDE.md (`npm run check`, `npm test`, `npm run e2e`; the adversarial reviewer only when a fix touched the pipeline). Merge with `gh pr merge --merge`, then from the primary clone `git gtr rm <branch>` and `git checkout main && git pull && npm run build`. The human reloads the extension only when `src/` changed.
