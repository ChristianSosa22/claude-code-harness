# Lessons that apply to every project

These rules come from feedback in earlier projects. A project rule in the project `CLAUDE.md` wins
over a rule here.

## Explain before you change or ask

- Before you rewrite an ADR, a design, or a spec, explain each point in the chat: what it is, what
  you would change, and why. Edit the file only after the answer.
- Before you ask for a decision, give one short explanation that stands alone: what the system
  does, what goes wrong (with an invented example), how often, the impact, the cause. Then give
  the options and your recommendation. Option labels with internal terms mean nothing without it.

## Scope

- If a review finds a defect that the change did not cause, fix only the part that the change
  caused. Record the rest in the open questions of the design (or the final report) and continue.
  Do not ask twice.
- If customer data shows that an internal policy was broken, record it as a finding. Do not clean
  the data in silence, because that removes the signal.

## Pull requests

- Open a draft PR (`gh pr create --draft`) for each group as soon as the tests and the reviewer
  pass. Do not wait for the previous PR to merge. The body says the merge order.
- Before each push to the branch of an existing PR, test the state value. `gh` exits 0 for every
  state:

  ```bash
  [ "$(gh pr view <n> --json state -q .state)" = OPEN ] && git push
  ```

  If the PR is merged, start a new branch from the base and cherry-pick. After stacked PRs merge,
  confirm with `git merge-base --is-ancestor <sha> origin/main`.
- A PR that changes a screen has before and after screenshots and a short e2e video. Upload the
  video to GitHub. Never commit it.

## Screens

- For a data feature, make a mockup of each screen before the specs and review it with the owner.
  Prefer a guided flow to a form that shows internal configuration. Show a chart that fits each
  kind of result, never a card with only text.
- After a group that changes screens passes its tests and the reviewer, show screenshots of each
  new screen and state in the reply. Wait for approval before the commit.

## Tests

- Each code group gets a local test that proves what runs in the deployed environment: the bundled
  handler, the names of the environment variables, the event that the orchestration builds. If the
  app has a local Docker mode, app groups also run it with Playwright, before and after. Browser e2e
  and Docker Compose run only on the local machine, never in CI.

## Data and secrets

- Never write real ids, customer names, agent names, or tenant domains in a committed file. Use
  invented values. Evidence of a live run records counts and classes, not ids.
- New field names that new code writes (JSON output, log keys, payload fields) are in English.
  The values can be in the language of the product. Do not rename old fields unless the owner asks.
- Never put a secret in code for the Playwright MCP `run_code` tool: the result prints the code.
  Let the owner sign in by hand, or run a separate script from Bash that reads the secret file.

## Tools

- Do not read the output of a running subagent. Wait for its hand-back.
- If the guard hook denies a command, give the owner the exact command. Do not work around it.
- Before a commit, parse each Mermaid block with mermaid 11 in Node (jsdom for `window`). Avoid
  `#` in sequence messages and edge labels, and `pk` or `sk` as attribute names in an erDiagram.
