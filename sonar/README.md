# SonarQube kit

This folder runs SonarQube Community in Docker on your machine (`127.0.0.1:9000`), and runs `sonar-scanner` in a
container. The code never leaves the machine, and the product repository gets no new dependency. The rules live in
one file: the config. `sonar-group` uses this folder as its hub (`SONAR_HUB`).

The scripts work on Linux and on macOS (Docker Desktop), with bash 3.2 or later.

| File | What it does |
|---|---|
| `up.sh` | Starts the server. If the container does not exist, it creates it from the config. |
| `apply.sh <project>` | Writes the project, the quality profile, the quality gate, the issue exclusions, and the new code period to the server. A second run changes nothing. |
| `scan.sh <project> <repo-root> [version]` | Analyzes a repository, waits until the server has processed the analysis, and prints the quality gate. This is the `scan.sh` that `sonar-group` calls. |
| `issues.sh <project> <files-list>` | Lists the open issues in a list of files. |
| `config.example.json` | An example config: a TypeScript profile on "Sonar way", a gate that fails on any new issue, and two projects. |
| `scanner-arm64/Dockerfile` | A native scanner image for arm64 hosts. |

## Requirements

- Docker, running.
- `jq` and `curl`. On macOS: `brew install jq`.
- On an arm64 host (a Mac with Apple Silicon), network access to Docker Hub and `binaries.sonarsource.com` for the
  first scan. `scan.sh` builds the native scanner image then.

## First time

1. Copy the example config, then edit the projects:

   ```bash
   cp sonar/config.example.json sonar/config.json
   ```

   Git ignores `sonar/config.json`. To keep the config in another place, set `SONAR_CONFIG` to its path.

2. Start the server:

   ```bash
   sonar/up.sh
   ```

3. Open http://localhost:9000, sign in with `admin` / `admin`, and change the password.
4. In *My Account → Security*, create two tokens:
   - a **User Token**, for `apply.sh`, which changes profiles and gates;
   - a **Global Analysis Token**, for `scan.sh`, `issues.sh`, and `sonar-group`.
5. Save each token in its file. The `read -s` command asks for the token and does not show it:

   ```bash
   umask 077
   mkdir -p ~/.config/sonar-group
   read -rs -p "User Token: " t && printf '%s' "$t" > ~/.config/sonar-group/admin-token && unset t && echo
   read -rs -p "Analysis Token: " t && printf '%s' "$t" > ~/.config/sonar-group/token && unset t && echo
   ```

   `SONAR_ADMIN_TOKEN_FILE` and `SONAR_TOKEN_FILE` change these paths. Never put a token in a repository.

6. Apply the rules of each project:

   ```bash
   sonar/apply.sh example-app
   ```

7. Set `SONAR_HUB` to this folder, for example in the shell profile:

   ```bash
   export SONAR_HUB="<path-to-the-clone>/sonar"
   ```

**WARNING:** These commands delete the volumes of the server, with all projects, tokens, and history:
`docker compose down -v`, `docker rm -v`, and `docker volume prune`. A change to `server.container` or
`server.volumes` on a server with data also starts an empty server. Do not use them on a server that you keep.

## Use

The usual entry point is `sonar-group` (see the main README). It calls `scan.sh` and blocks only on the issues in the
lines that the staged diff adds.

To analyze a repository directly:

```bash
sonar/scan.sh example-app /path/to/example-app my-feature
```

The third argument is the version of the analysis, for example the name of the change. If the repository is a git
worktree, `scan.sh` mounts it read-only at its own host path, so that `git blame` works as in a normal checkout.

To list the issues of some files, write one repository path per line in a file:

```bash
git -C /path/to/example-app diff --name-only --cached > /tmp/files.txt
sonar/issues.sh example-app /tmp/files.txt
```

## The config

- `server` and `scanner`: the images (pinned by digest), the container, the port, and the volumes.
  `scanner.memory` caps the memory of the scanner container, with no swap. `scanner.node_maxspace_mb` caps the Node
  heap of the JS/TS analyzer. If a scan stops with "Node.js process running out of memory", raise the two values
  together.
- `profile`: the quality profile, its parent, and the rules with changed parameters. `deactivated_rules` lists the
  rules that the profile must not have. If you remove a rule from `rules`, `apply.sh` resets it to the value of the
  parent. A rule that the parent has active cannot be deactivated in the child; the API error stops the run.
- `gate`: the quality gate on new code. `remove_metrics` removes conditions, for example the coverage condition that
  SonarQube adds to each new gate.
- `defaults` and `projects`: the paths of the analysis and the issue exclusions. Each project gets the defaults merged
  with its entry. A project can change a field or add `extra_issue_exclusions`. An empty value skips that scanner
  property. `coverage_report` sets an LCOV report path.
- `new_code_period`: `PREVIOUS_VERSION` by default. See "Pin the baseline of a worktree project".

### Change a rule

Edit the config, then run `apply.sh <project>` again. Do not change the rules in the web interface: the next run of
`apply.sh` writes over them.

### Won't fix and exceptions

A "Won't fix" in the web interface lives only on the server, and a new server loses it. Put each such decision in
`issue_exclusions` of the config, for one rule and one file pattern, with a `reason`. Then run `apply.sh` again.

```json
{ "rule": "S2245", "resource": "src/retry.ts", "reason": "Jitter of a retry delay; not a security use" }
```

## Native scanner on arm64

Every tag of the official image `sonarsource/sonar-scanner-cli` is amd64 only. On an arm64 host, that image runs
under emulation and a scan takes about twice as long. So on an arm64 host, `scan.sh` builds and uses an image from
`scanner-arm64/Dockerfile`: the same scanner CLI for `linux-aarch64` (with its SHA-256), Node.js, and `git`.

- The image tag comes from the content of the Dockerfile, so a change to the Dockerfile builds a new image.
- `SONAR_SCANNER_NATIVE=0 sonar/scan.sh ...` uses the official image, for example to compare the results.

## Pin the baseline of a worktree project

With `PREVIOUS_VERSION`, the new code starts at the last analysis with another version. In a worktree, an earlier
scan can move that baseline, and then `new_violations` grows with no warning. To pin the baseline:

1. In the project entry, set `"new_code_period": "SPECIFIC_ANALYSIS"` and `"baseline_version": "<name>-<sha7>"`.
2. Scan a clean worktree at that commit, with that version:
   `sonar/scan.sh <project> <worktree-at-sha> <name>-<sha7>`. Branch scans use other versions, never this one.
3. Run `sonar/apply.sh <project>`. It finds the analysis with that version and that commit, pins it, and examines
   the stored value. If no such analysis exists, it stops and says which commit to scan.

## Access from another machine

Open a tunnel, then open http://localhost:9000:

```bash
ssh -N -L 9000:127.0.0.1:9000 <user>@<host>
```

## Limits

- The quality gate measures new code with `git blame`. The scanner cannot blame a file with uncommitted changes. The
  server gives those lines the date of the analysis, so they count as new code.
- One analysis at a time: `scan.sh` refuses to start when another `sonar-scanner` container runs.
- On macOS, the scanner reaches the server through `host.docker.internal`, because Docker Desktop has no host network.
- On macOS, `scan.sh` runs under `caffeinate -i`, so an idle sleep does not stop the scan. A closed lid still stops it.
