# About

Rescribe is a Chrome extension (Manifest V3) that records what happens in a tab, a window or the whole screen, mostly Google Meet calls, and saves two assets per recording into a folder the human chooses: the **video** and a **speaker-attributed transcript**. Everything runs locally in the browser: the extension makes no API calls, and has no servers and no accounts. After a recording, an optional **routine** the human picks (a script in `routines/`, run outside the browser through a native messaging host in `native/`) hands the transcript to their other tools, such as Claude Code for "Index in Lawcel". Speech recognition is NVIDIA Parakeet running in-browser on WebGPU. Speaker attribution comes from recording the microphone and the shared audio as separate channels, plus platform metadata (who Meet shows as speaking).

Vanilla TypeScript, no UI framework. `src/` is bundled by esbuild into `dist/`, which Chrome loads unpacked. Start with [[AGENTS/DNA/ARCHITECTURE]] for the topology and [[AGENTS/DNA/DECISIONS]] for the rulings.

# DNA: architectural guardrails

`AGENTS/DNA/` holds the project's architectural guardrails: what the project *is*, its decisions, structure and contracts. The DNA grows as the project does, but must never drift from the code. It evolves but doesn't change. Contributions that violate DNA cause cancer and must be avoided.

1. Don't violate DNA.
2. Grow DNA. When your work adds new structure, record it.
3. Don't let it drift. If something in DNA no longer matches the code, fix it. If it's unclear whether DNA or code should change, think deeply and resolve it only if you are certain, otherwise ask the human.
4. Do not take DNA changes lightly. Err on the side of asking the human before changing an existing DNA item.

**Each file holds one kind of statement**, so that a fact lives in exactly one place:

| File | Holds | Test |
|---|---|---|
| [[DECISIONS]] | A **choice** among alternatives we could have made differently. | Could someone violate it by choosing otherwise? |
| [[INVARIANTS]] | What must stay **true at runtime**, and the failure that taught it. | Could you write a test that fails when it stops being true? |
| [[ARCHITECTURE]] | **Where** code and data live: file structure, data model, module boundaries, runtime topology. | Could you verify it with `ls` or by opening the file? |
| [[PRODUCT]] | What the **human** gets: vision, the two assets, the feature inventory. | Could a user observe it? |
| [[DEVELOPMENT]] | How to **work on** the extension: setup, build, load, test, self-test, release. | Is it a thing you *do*, not a thing the app does? |

Read the DNA files relevant to your task, not all of them. Any implementation work: [[DECISIONS]] and [[ARCHITECTURE]]. Recording, audio, transcription or attribution logic: also [[INVARIANTS]]. Writing tests or touching the build: also [[DEVELOPMENT]]. Scope questions: [[PRODUCT]]. Unclear scope: all of them.

# Where knowledge goes

An agent-private memory is invisible to every other agent. **Anything true about how this repo behaves must be written into the repo, not into private memory.**

| What you learned | Where it goes |
|---|---|
| A structural fact about the code: a decision, a contract, a convention | `AGENTS/DNA/` (pick the file by the table above) |
| A guard or ordering rule that must not break, especially one a bug taught you | [[INVARIANTS]] |
| An environment trap, a shared-resource collision, a verification recipe | [[ENVIRONMENT_NOTES]] |
| A category of error worth not repeating | [[AGENT_MISTAKES]] |
| Tech debt with a trigger | [[DEFERRED]] |
| A check that only a real call or the human's own Chrome can run | [[LIVE_CHECKS]] |
| A manual task only the human can do | [[HUMAN_TODO]] |
| The human's preferences, or state local to your session | private memory |

# Optional checks before starting work

- **GitHub Issues** (`gh issue list`, repo `ulfaslak/rescribe`) is the single source of truth for dev work. An open issue with a claim comment (`🔨 Started work on this.`) is being worked on by another agent: read it with `gh issue view <N> --comments` and keep away. When you pick one up, post the claim yourself. Skip anything labelled `eventually`.
- [[HUMAN_TODO]]: remove completed entries, add new ones only for things that need the human's hands.
- [[LIVE_CHECKS]]: if you are in a session where the human is in a call, or has just recorded one, run the entries whose trigger has fired.

# Before writing ANY code

- **Create a worktree.** All implementation work happens in a git worktree branched from `origin/main`, never on `main` directly. The only exception is the human explicitly saying so. No size exceptions: a one-line fix follows the same worktree → PR → self-test → learn cycle.
  1. `git gtr list` to see existing worktrees. Never touch or remove one you didn't create.
  2. From the primary clone: `git gtr new <branch>` (worktrees land in `../rescribe-worktrees/<branch>/`; `.gtrconfig` runs `npm install`).
  3. Work, commit and push from the worktree.
  4. After merge, from the primary clone: `git gtr rm <branch>`, then `git checkout main && git pull`.
- **Commit early in worktrees.** A force-removed worktree destroys uncommitted work.
- Never run a destructive git command to inspect state (`reset --hard`, `checkout -- .`, `stash`, `clean`). Inspect with `git show`/`git diff`.
- Never amend, rebase or force-push unless explicitly asked.

# During work

- Never push directly to `main`. Every change goes through a PR: branch, commit, push, `gh pr create`, self-test, merge with `gh pr merge --merge`.
- Don't manufacture a GitHub issue to fit a task into the tracker. A self-standing PR is fine. When a PR addresses an existing issue, put `Closes #N` in the body.
- Put the session ID in every PR body as a footer: `Session: $CLAUDE_CODE_SESSION_ID`.
- Never contradict [[DECISIONS]]. If a decision seems wrong, raise it with the human.
- Follow the file structure in [[ARCHITECTURE]].
- **Decide, then surface.** Unspecified details (scope edges, UX details, a tangential sub-feature) are yours to decide when a wrong call costs a follow-up PR, not data. Ask when the call is irreversible, affects how the human experiences the product in a way they'd want to own, or is architectural and cross-cutting. List every autonomous call in the PR body under `## Decisions taken without asking`.

# After work: the test-fix-learn cycle

Non-negotiable for every PR, including one-line fixes.

1. **First pass.** `npm run check`, `npm test`, `npm run e2e`. Update DNA for any structural fact you introduced; update the feature inventory in [[PRODUCT]] if a user-facing capability changed. Open the PR with `## Summary`, `## Test plan` (checklist) and, when applicable, `## Decisions taken without asking`. The last commit message of this phase ends with `[not user-tested]`.
2. **Self-test, picking the method that produces signal** (see [[DEVELOPMENT]] § "Self-testing"): a Playwright walk of the extension with fake media for anything in the record-to-transcript path; unit tests for pure logic; the real Chrome for anything that fake devices cannot exercise, which then becomes a [[LIVE_CHECKS]] entry. Enumerate edge cases on paper before testing: stream lifecycle (track ended, picker cancelled, mic denied, tab closed mid-recording), clock edges (recording-relative vs wall time), long recordings, silence, overlapping speakers, storage (quota, folder permission revoked). Fix everything you find as fix commits on the branch, and run the negative control once per fix: make the check fail, then re-apply.
3. **Adversarial review** for any diff touching the pipeline (`src/lib/`, the recorder, workers, content adapters): spawn the `adversarial-reviewer` agent with only the diff and file paths, never your reasoning. Triage its findings yourself.
4. **Document mistakes** only if self-testing found real bugs: a `## Mistakes found during self-testing` section in the PR and an entry in [[AGENT_MISTAKES]]. Don't fabricate.
5. **Clean up.** Kill watchers and browsers you started. Merge. Then from the primary clone: `git checkout main && git pull && npm run build`, and tell the human to reload the extension at `brave://extensions` (see [[DEVELOPMENT]] § "Release").

# Closing a response

End every response that wraps up substantial work (a feature, a multi-commit fix, a deep investigation) with this closer, in this order, and nothing after it. Skip it for short answers and routine replies.

```
## ⚠️ HEADS UP

<ONE ALL-CAPS SENTENCE PER ITEM, ~15 WORDS MAX>
> optional lowercase detail, as a blockquote directly under its flag

## Recap

<1–3 plain sentences, under 40 words>

## Next steps

- <one bare action the human takes>
```

- **`## ⚠️ HEADS UP` only when something diverged from what the human asked or expected.** The human skims closers assuming "went as instructed, everything works", so ALL CAPS is the one signal that breaks the skim. Flag it when: you implemented something differently from the instruction; you found something that changes the picture (a wrong assumption, a pre-existing bug, data that isn't what everyone thought); part of the task is unfinished, unverified, skipped or blocked; you made a judgment call the human would plausibly reverse; something irreversible happened; the human must do something by hand for the work to land. **The test is surprise, not importance.** Do not flag normal successful work, passing tests, decisions already surfaced in the PR body, or the expected consequences of the human's own instructions. If nothing diverged, write no heads-up section at all: never an ALL-CAPS "ALL GOOD". Max 3 flags. Keep ALL CAPS out of the rest of the message. A flag's only accepted sub-detail is one `> lowercase` blockquote line directly beneath it; never fake an indent with spaces or `&nbsp;`.
- **`## Recap`** is a landing strip, not a summary of the session: under 40 words, 1–3 plain sentences, no bullets, no bold. Lead with the goal and where it landed. Root cause, fix internals and secondary detail belong in the body above, not here. Any GitHub issue the session created is named here (or in Next steps if the human has to act on it) as a clickable link with a half-line of what it tracks; the human never first discovers a filed issue by browsing the tracker.
- **`## Next steps`** holds only what **the human** does next: max 3 one-line bullets, each a bare action with no rationale clause. Anything you can do yourself is not a next step; do it instead. **When there is nothing for the human to do, omit the section, heading and all.** Never a heading followed by "Nothing", "You're all set" or "Just review when you get a chance". A clean, fully-shipped piece of work ends at the Recap.
- Anything you name in the closer that can carry a link gets one, as a markdown link with short display text: `[#28](https://github.com/ulfaslak/rescribe/pull/28)`, never a bare `#28` or a bare URL. Not in PR or issue bodies, where `Closes #N` must stay bare.

# Guardrail changes

The human is the gatekeeper. To change a guardrail, propose the change explicitly and wait for approval.
