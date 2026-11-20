# Harness metrics

This document defines the six metrics that measure the Claude Code harness in this repository:
the rules of `CLAUDE.md`, OpenSpec, the main agent, the `reviewer` agent, the second-opinion agent,
the memory, and the `guard_bash.py` hook. Each metric answers a decision about the harness.

## How to run it

```bash
npm run harness:metrics                        # last 28 days
npm run harness:metrics -- --since=2026-10-07  # from a date
npm run harness:metrics -- --no-classify       # without the metrics that Haiku classifies
```

The script reads three sources:

1. `origin/main` of git: the history of each change in `openspec/changes/archive/`.
2. The GitHub deployments of the `prod` environment, with `gh api`. If the project uses another
   name, change `environment=prod` in `scripts/harness-metrics.ts`.
3. The Claude Code transcripts in `~/.claude/projects/`, from all the folders whose name contains
   the name of the main worktree. Thus the other worktrees of the repository also count.

The script saves the report in `~/.claude/harness-metrics/<date>.md` and prints it to the console.

> **NOTE:** Metrics 4b and 5 use Haiku (`claude -p --model haiku`) to classify the FAIL reports of
> the reviewer and the prompts. The script keeps the labels by hash in
> `~/.claude/harness-metrics/labels.json`, outside the repository, because the prompts can contain
> real data. A second run classifies only the new texts.

The script also reads the Spanish words of the earlier template (`ronda`, `VEREDICTO`,
`caso-borde`, `alcance`, `error-spec`, and the `revisor` agent), so a project that started with it
keeps its history.

## The six metrics

| # | Metric | Definition | Target | Decision that it guides |
|---|---|---|---|---|
| 1 | Spec first-pass yield | % of archived changes with no commit to `proposal.md`, `design.md`, or the specs after the first `[x]` task | ≥ 60 % | Is the planning sufficient? |
| 2 | Review rounds in planning | Median of `spec(<change>): round N` commits before the first `[x]` task | ≤ 3 | Are mockups, questions, or context missing before the spec? |
| 3 | Rework in prod (rework rate) | % of successful deploys of `main` to `prod` that include a `fix`, `hotfix`, or `revert` commit and ship within 72 hours of the previous deploy | < 10 % | Do errors reach prod? |
| 4a | Reviewer FAIL on the first verdict | % of reviews whose first verdict is `FAIL`, without `DIFF TOO LARGE` | 15 %–30 % | Does the reviewer examine enough? |
| 4b | FAIL with a substantive finding | % of those FAILs whose most severe finding is not about style (bug, spec gap, missing test, security, or data) | ≥ 70 % | Is the reviewer worth its cost? Must a style rule move to a hook or a lint? |
| 5 | Corrections per prompt | % of prompts that say the agent made an error, did not understand, or must do something again | < 5 % | What context is missing as memory or as a rule? |
| 6 | Context per call | Mean of input tokens (cache included) per call of the main session | < 150k | Must one session cover only one change? |

The targets are an initial proposal, not a public standard. For metrics 1, 2, and 5 there is no
public reference for work with agents. Your own trend is the guide.

## References

| Metric | Reference | Source |
|---|---|---|
| 3 | Rework rate: unplanned deploys because of an incident in production ÷ deploys. The best group is below 2 % (7 % of teams). Elite change failure rate: 5 %. | DORA, [dora.dev/guides/dora-metrics](https://dora.dev/guides/dora-metrics/); 2024 levels according to Octopus |
| 4b | In human reviews, about 15 % of the comments point to a defect, and about 75 % of the defects found are about maintenance | Czerwonka et al., ICSE 2015; Mäntylä and Lassenius, IEEE TSE 2009 |
| 5 | Interrupts per turn: 5 % at the start, about 9 % for experienced users. 32 % of the interrupts come from missing context or a correction | Anthropic, [Measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy), February 2026 |
| 6 | Subagents return summaries of 1 to 2k tokens so that the main context does not grow | Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), September 2025 |
| All | To evaluate an agent: tokens, turns, tool calls, and cost per task, in addition to the result | Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), January 2026 |

## Limits

- Metric 3 is an upper limit: a fix within 72 hours can be an adjustment of a new feature and not
  an incident.
- Metric 2 counts only the changes that follow the commit rule of `CLAUDE.md`. Changes archived
  before you adopt that rule show "no record".
- Metrics 4b and 5 depend on the classification by Haiku. If a batch comes back incomplete, those
  texts stay without a label, and the next run tries them again.
- Claude Code deletes old transcripts after `cleanupPeriodDays` (30 days by default). Without
  transcripts there is no baseline from before the harness.
