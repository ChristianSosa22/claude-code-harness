# <project name>

<One line: what the project does and for whom.>

## Comments in the code

- No comment that narrates what the code does. A comment only when it explains a reason or a
  constraint that the code cannot show; the narrative goes to the documentation (`*.md`, `docs/`,
  ADRs, and OpenSpec), to the commit message, or to the PR.
- Not allowed: the history of the change, a TODO without an owner, or a comment that repeats the
  name of the function or the resource. The directives that a tool reads (shebang,
  `eslint-disable`, `@ts-expect-error`, `# noqa`, `# shellcheck`) stay allowed.

## OpenSpec

- The OpenSpec root is the root of the repository. Run the `openspec` commands from the root.
- A change has a `proposal.md`, a `design.md`, and its specs. The scenarios of the specs are the
  finish line: each one ends as a test with the name of the scenario. `tasks.md` is the progress
  list of the change, not a script per task. The rules are in `openspec/config.yaml`.
- Implementation: the main session implements the change from end to end. It does not delegate the
  implementation to an agent. It can divide work among subagents when the change is large and
  parallel; if it does, it examines the evidence of each subagent before it accepts it. Start
  with `/opsx:apply <change>` and follow the section "Implement a change".
- Review: before the commit of each group of `tasks.md`, the main session starts the `reviewer`
  agent with `subagent_type: reviewer`, never with `fork`. A group with a `[critical]` item also
  gets a second reviewer in `MODE: critical` on that function. Correct each `FAIL` before the
  commit and send it again to the same reviewer with `SendMessage`. Do two rounds or less per
  group; at the third, stop and ask. Mark an item of `tasks.md` only with `PASS`. The
  `UNCOVERED CASES` of the verdict do not block: the main session does not implement them and does
  not change the spec for them. It lists them under **Found** with their group, and I decide if
  they go into the spec.
- Verify with `<type check command>` and `<test command>`. The close of a change runs
  `<coverage command>`.

## Rules for the reviewer

The reviewer receives this section, literal, in `PROJECT RULES:`.

- <A rule that the reviewer checks in each diff. Example: no log contains the text of a message.>
- <The naming convention of resources. Example: resources have the prefix `<org>-{stage}-<app>-`.>
- <A rule about sensitive data or permissions.>

## Implement a change

With `/opsx:apply <change>`, in addition to what the command asks:

1. Before the first group, run `openspec validate <change> --strict` and read `proposal.md`,
   `design.md`, and all the specs. The "Guide for the implementer" of the design sets names,
   signatures, and folders. Do not rewrite specs or the design; if a scenario cannot be met, stop
   and ask. Record the SHA of `HEAD` as the base of the diff of the first group.
2. Per group: implement, write one test per scenario with its name, run the type check and the
   tests of the group, and run `git add -A`.
3. Build the reviewer prompt from the root of the repository:
   - scenarios: `awk '/^#### Scenario: /{p=1} p' <spec.md>`, only those that the group covers;
   - decisions: `awk '/^### N\. /{p=1;next} /^### /{p=0} p' design.md` for each one that applies;
   - diff: `git diff --cached -- <group files> ':!package-lock.json'`;
   - the list of source files and test files;
   - `TESTS:` `<type check command>; <test command of the group with the coverage of its files>`;
   - `PROJECT RULES:` the section "Rules for the reviewer" of this file;
   - `MODE: normal`.

   With `DIFF TOO LARGE`, do the review again per item.
4. With `PASS`, mark the group in `tasks.md`, show the diff if it is `[critical]`, commit the group,
   and open its draft PR. The message says what the code does.
5. Close: run `<coverage command>`; check that each `#### Scenario` of the specs has a test with its
   name (`grep -rh "#### Scenario:" openspec/changes/<change>/specs` against the test names); write
   the report with the sections below, plus coverage, commits, and the verdicts of each reviewer.
   Then offer `/opsx:archive <change>`.

## Spec commits for the harness metrics

`npm run harness:metrics` counts the spec adjustments from these commit subjects. Definitions and
targets: `docs/harness-metrics.md`.

- Planning: each time that you change `proposal.md`, `design.md`, or the specs because of my
  feedback, before the first `[x]` task, make a commit with only that change and the subject
  `spec(<change>): round N — <what changed>`. The first complete version of the spec is round 1.
- After the first `[x]` task: a change to `proposal.md`, `design.md`, or the specs goes in its own
  commit with the subject `spec(<change>) [<cause>]: <what changed>`. The cause is one of `ui`,
  `ux`, `edge-case`, `scope`, or `spec-error`.

## When to continue and when to stop

When a step does not need my answer, continue. Put the progress notes in the same message as the
next action, and update `tasks.md` of the change when you close each item.

Stop and ask only when you cannot continue without me, or before:

- any action against a live environment: deploy, `terraform plan` or `apply`, manual runs,
  contract tests, reads of real data;
- a move of a ticket in the issue tracker (Jira, Linear, GitHub Issues, or another), or a comment
  on it;
- a delete of data, a rewrite of git history, or a push outside the work branch;
- the close of a change in <sensitive areas of the project: permissions, secrets, masking>. Show
  those diffs before you close them.

If a test fails for a reason that you cannot explain, stop and say so with the output.

## Report at the end

Close each long run with three sections, in this order:

1. **Blocked on me**: open decisions or changes that wait for my approval.
2. **Changed**: what you built, with files and commits.
3. **Found**: what did not agree with the design or the specs, and what you could not confirm,
   with where you looked.

## Code conventions

- Code in English: identifiers, files, folders, and columns. <The language of the UI text.>
- Tests: files, `describe`, and variables in English; the text of each test is the name of the
  scenario.
