## Harness v2: one session per group

This branch tests harness v2 against v1, which is one session for the full change. The comparison
comes from the table "Per change and harness version" of `npm run harness:metrics`. These rules add
to "Implement a change" and win where they conflict with it.

- A new change has the line `harness: v2` in its `.openspec.yaml`, from the commit that creates the
  change.
- A session implements only one group of `tasks.md`. It starts with `/opsx:apply <change>` and the
  handoff note of the previous session.
- The session of the first group does step 1 in full. The others run `openspec validate <change>
  --strict` and read `proposal.md`, the "Guide for the implementer" of the design, the decisions
  that apply, and the scenarios of their group. Other specs only if the group depends on them.
- With the `PASS` of the reviewer, the commit, and the draft PR of the group, the session stops. Its
  last message is the usual report and, at the end, the handoff note in a code block:

  ```text
  /opsx:apply <change>
  Harness v2 · group <N> of <total> · branch <branch> · diff base <SHA>
  Done: <closed groups with their PR>.
  Open decisions: <list or "none">.
  Owner instructions that are not in the spec or in the memory: <list or "none">.
  ```

- An instruction of mine that the next session needs goes to the note or to the memory. It does not
  stay only in the chat.
- The close of step 5 (coverage, report, `/opsx:archive`) is the last session of the change.

### Reading in v2

- To find something, use Grep or `grep -n` and read only the range that you need. Do not read in
  full a file of more than 300 lines.
- Do not read again a file that you already read in the session if it did not change.
- A broad search, in more than 5 files or without knowing where it is, goes to an `Explore`
  subagent, which returns only the conclusion.
- Filter the output of tests and builds, for example with `| grep -E "^Tests:|✕|error"` or `tail`.
  Do not show the full output.
