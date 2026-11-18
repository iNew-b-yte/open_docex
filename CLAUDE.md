# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- **Main session (orchestrator):**
  - It is the main agent described in AGENTS.md §4.
  - It spawns one worker subagent per task, using `isolation: "worktree"` for tasks that run in parallel.
  - It keeps `EXECUTION_PLAN.md` status current and commits it.
- **Worker subagents:**
  - Their prompt contains the task ID, the task's file scope, the cited LLD sections and the acceptance criteria.
  - They don't spawn further agents.
- **Skills:** load the matching skill before work:
  - `backend`, `frontend`, `testing`, `security`, `api-design`, `algorithms`
  - `debugging` for defects
  - `ship` before marking a version done
- **Questions:** when a decision isn't covered by the BRD, `HLD.md` or `LLD.md`, ask the project owner with AskUserQuestion. Never decide on their behalf.
