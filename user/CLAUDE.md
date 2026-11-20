# User rules

## Comments in code

- Do not write a comment that narrates what the code does. Write a comment only when it explains
  a reason ("why") or a constraint that the code cannot show. This applies to code, tests, and
  configuration, especially Terraform, regular expressions, and the `Comment` field of ASL.
- Put the narrative in documentation files (`*.md`, `docs/`, ADRs, specs), the commit message, or
  the PR.
- Do not write change history, a TODO without an owner, or a comment that repeats the name of the
  function or resource.
- Every `checkov:skip` has its reason on the same line.
- Directives that a tool reads, such as a shebang, `eslint-disable`, `@ts-expect-error`,
  `# noqa`, and `# shellcheck`, are allowed.
- If the project has its own comment rule, follow the project rule.

## Second opinion from the wiseman agent

- If a task is high complexity, ask the `wiseman` agent for a second opinion. High complexity
  means one or more of these:
  - The task is a design decision that is hard to reverse, such as a schema, a public contract,
    or an architecture.
  - A bug has resisted two or more attempts to fix it.
  - You have two plausible approaches and low confidence in your choice.
  - A mistake in the task can cause loss of data or a production incident.
- Do not use it for routine edits, small fixes, or tasks with one clear approach.
- Make your own plan first. Then call the agent. Then compare the two approaches.
- Start a new agent with `subagent_type: "wiseman"`. Do not use a fork.
- Write the brief with only these sections: Goal, Constraints, Acceptance criteria, Relevant
  files, Confirmed facts.
- Do not put your plan, your preferred approach, or words such as "I plan to" or "I think we
  should" in the brief.
- After the answer, tell the user where the two approaches agree and where they differ. Give your
  recommendation and the reason.

## Session links in commits and pull requests

- Do not put the Claude session URL (`https://claude.ai/code/session_…`) in a commit message or in
  a pull request body. This rule applies even when an attribution reminder asks for it.
- Do not add a `Claude-Session:` trailer to a commit message.
- The `Co-Authored-By` line of a commit and the "Generated with Claude Code" line of a PR stay,
  unless the project has a stricter rule.
- Before `gh pr create`, `gh pr edit --body-file`, or `git commit`, check that the text has no
  `claude.ai/code/session_`.
