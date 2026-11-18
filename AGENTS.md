# AGENTS.md — rules for every agent working on open_docex

These rules apply to every AI agent and every human contributor implementing open_docex. Read this file completely before starting any task.

## 1. Sources of truth (in order)

1. **BRD**: `draft_description_of_the_product_package.docx`. It defines scope. Anything not in it is out of scope.
2. **`HLD.md`**: architecture, decisions and contracts. A master document.
3. **`LLD.md`**: modules, types, algorithms and tests. A master document.
4. **`EXECUTION_PLAN.md`**: tasks, dependencies, owners and status.
5. **`VERSION_PLAN.md`**: what ships in which version.

If two of these disagree, or a task needs something none of them answers: **stop, do not guess, and ask the project owner.** Record the question in `EXECUTION_PLAN.md` → "Open questions".

## 2. Hard rules

- **No assumptions or inferences.** Verify against the documents above, against the code, or against a library's current docs. If you can't verify something, ask the project owner.
- **No scope creep.** Implement only what the current task and the LLD define. Section B items belong to V6 and ShareDB to V7. Neither may leak into V1–V5.
- **Contracts are frozen.** The following change only through an approved HLD/LLD update, made in the same commit:
  - `@open-docex/shared` public API
  - protocol messages
  - error codes
  - adapter ports (`StorageAdapter`, `QueueAdapter`, `AnnotationStore`)
  - IPC messages
  - public option types
- **Licences.** Dependencies must be MIT, BSD, ISC or Apache-2.0. No GPL, AGPL or commercial packages, and no `@univerjs-pro/*`. LibreOffice (MPL-2.0) is an external program and is never bundled. CI enforces the allowlist.
- **Security.** Follow HLD §14 and the LLD security controls:
  - no shell spawning with input
  - no paths built from raw input
  - no `innerHTML`
  - never log tokens or headers
  - send clients sanitized errors only
- **Report truthfully.** Never claim tests pass without running them. Report failures with their output.

## 3. Repository layout

```
shared/    @open-docex/shared   isomorphic: no Node or DOM APIs
backend/   @open-docex/server   Node.js only
frontend/  @open-docex/client   browser only (React internal, peer dependency)
```

Dependency rule: `client → shared ← server`. The client never imports server code, and shared never imports either.

Toolchain:
- Node.js 22, 24 or 26
- npm workspaces
- TypeScript (strict, ESM)
- Vitest and Playwright
- LibreOffice installed locally, for codec tests

The exact commands are in `LLD.md` (Part 1, tooling) and in the root `package.json` once the bootstrap task is done.

## 4. Parallel work model

**Main agent (orchestrator)**, one per work session:
- Owns `EXECUTION_PLAN.md`. Picks the next tasks whose dependencies are `done` and assigns each to one worker agent, giving the task ID.
- Gives each worker only that task's scope, the LLD sections it needs, and its acceptance criteria.
- Tracks status: `todo → in-progress → review → done`, or `blocked` (with the reason).
- Reviews each worker's result against its acceptance criteria and the LLD:
  - The tests must have been run and must pass.
  - Only files in the task's scope may be touched.
- Merges finished work into `main`, updates the plan and commits.
- Escalates questions to the project owner and never answers them on the project owner's behalf.

**Worker agents:**
- Work on exactly one task, in their own git worktree or branch named `task/<TASK-ID>-<short-slug>`.
- Touch only the files the task lists. If another file must change, stop and report to the main agent.
- Write the tests named in the task, then run typecheck, lint and tests for the affected packages.
- Report back:
  - what changed (files)
  - test output (pass/fail counts)
  - any deviation or question

**Tasks that may run in parallel:** tasks with no dependency between them and no overlapping files. The plan marks these with matching `track` values and disjoint file scopes.

## 5. Definition of done (every task)

- [ ] Implements exactly what the LLD sections cited in the task specify.
- [ ] Unit and integration tests from the task written and passing. The command and its output are in the report.
- [ ] `typecheck` and `lint` pass for the affected packages.
- [ ] No new dependency outside the licence allowlist. Any new dependency is named in the report.
- [ ] Public API and docs comments updated where the task changes them.
- [ ] Acceptance criteria in `EXECUTION_PLAN.md` met.

## 6. Git rules

- Commit after each meaningful step so that no work is lost.
- **Never add `Co-Authored-By` or any other co-author trailer to commits in this repository.**
- Commit messages are short and in the imperative ("Add journal replay"). The task ID goes in the body.
- Never force-push `main`, and never rewrite history that has been pushed.
- Push to `origin` only when the project owner asks.

## 7. Changing HLD/LLD

1. Propose the change (what, why, and the impact on tasks) to the project owner.
2. Once approved, update `HLD.md` and/or `LLD.md` and the affected tasks in `EXECUTION_PLAN.md` in one commit.
3. Never change code first and the documents later.
