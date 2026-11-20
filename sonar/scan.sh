#!/usr/bin/env bash
# Runs sonar-scanner in a container on a repository, sends the analysis to the local SonarQube, waits until the server
# has processed it, and prints the quality gate. The code never leaves the machine. The analysis token comes from
# SONAR_TOKEN_FILE and goes to the container only through the environment.
# Usage: sonar/scan.sh <project-key> <repo-root> [version]
set -euo pipefail

# On battery, macOS sleeps after one idle minute, and a sleep stops the scan. caffeinate -i holds off idle sleep
# until this script ends.
if [ "$(uname -s)" = "Darwin" ] && [ -z "${SONAR_SCAN_AWAKE:-}" ] && [ -x /usr/bin/caffeinate ]; then
  SONAR_SCAN_AWAKE=1 exec /usr/bin/caffeinate -i "$0" "$@"
fi

# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_tools jq docker

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail "Usage: scan.sh <project-key> <repo-root> [version]"
project="$1"
version="${3:-local}"
[ -d "$2" ] || fail "Repo root not found: $2"
repo_root="$(cd "$2" && pwd)"
settings="$(project_cfg "$project")"
official_image="$(cfg '.scanner.image')"
scanner_memory="$(cfg '.scanner.memory')"
node_maxspace_mb="$(cfg '.scanner.node_maxspace_mb')"
port="$(sonar_port)"
label="harness.sonar-scanner"

SONAR_TOKEN="$(read_token "${SONAR_TOKEN_FILE:-$SONAR_DEFAULT_TOKEN_FILE}")"
export SONAR_TOKEN

# Every tag of the official scanner image is amd64 only. On an arm64 host it runs under emulation and takes about
# twice as long, so there the image comes from scanner-arm64/: the same scanner CLI, built natively.
# SONAR_SCANNER_NATIVE=0 forces the official image, for example to compare results.
case "${SONAR_SCANNER_NATIVE:-auto}:$(uname -m)" in
  auto:arm64 | auto:aarch64)
    native_context="$SONAR_DIR/$(cfg '.scanner.arm64.context')"
    [ -f "$native_context/Dockerfile" ] || fail "Missing $native_context/Dockerfile"
    # The tag follows the Dockerfile content, so an edit builds a new image instead of reusing an old one.
    scanner_image="$(cfg '.scanner.arm64.repository'):$(cksum < "$native_context/Dockerfile" | cut -d' ' -f1)"
    if ! docker image inspect "$scanner_image" > /dev/null 2>&1; then
      echo "Building $scanner_image (only after a change to $native_context/Dockerfile)"
      docker build -q --platform linux/arm64 -t "$scanner_image" "$native_context" > /dev/null
    fi
    # Own cache: the official image unpacks an x86-64 Node.js runtime into its cache.
    cache_name=sonar-scanner-linux-arm64
    ;;
  *)
    scanner_image="$official_image"
    cache_name=sonar-scanner
    ;;
esac

# One scan at a time: two scanners on the same server overwrite each other.
if [ -n "$(docker ps -q --filter "label=$label")$(docker ps -q --filter "ancestor=$official_image")" ]; then
  fail "Another sonar-scanner container is running; wait for it to finish"
fi

network_args=()
if [ "$(uname -s)" = "Darwin" ]; then
  # Docker Desktop has no host network; the host is reachable by name.
  host_url="http://host.docker.internal:$port"
else
  network_args=(--network host)
  host_url="http://127.0.0.1:$port"
fi

# Only report-task.txt goes to the host. The working directory stays in the container, because on a Docker Desktop
# bind mount the report compression is more than ten times slower. It is not /tmp/.scannerwork: the official image
# creates that folder for its own uid 1000, and the scanner runs as the host uid.
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/sonar-kit/$cache_name"
mkdir -p "$cache_dir"

# optional_arg <setting> <scanner property>: adds -D<property>=<value> only when the project sets a value.
optional_args=()
optional_arg() {
  local value
  value="$(jq -r --arg f "$1" '.[$f] // empty' <<< "$settings")"
  [ -z "$value" ] || optional_args+=("-D$2=$value")
}
optional_arg sources sonar.sources
optional_arg tests sonar.tests
optional_arg test_inclusions sonar.test.inclusions
optional_arg exclusions sonar.exclusions
optional_arg tsconfig sonar.typescript.tsconfigPaths
optional_arg coverage_report sonar.javascript.lcov.reportPaths

# In a git worktree, `.git` is a file that points into the main repository. The JGit of the scanner takes the work
# tree from the `gitdir` file, which holds the host path. So the worktree mounts read-only at its own host path, and
# the git common dir mounts read-only at its own path. A normal checkout keeps the `/usr/src` layout.
repo_mount="$repo_root:/usr/src"
git_args=()
scm_args=()
base_dir_args=()
if [ -f "$repo_root/.git" ]; then
  repo_root="$(cd "$repo_root" && pwd -P)"
  git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir 2> /dev/null)" ||
    fail "Cannot resolve the git directory of the worktree $repo_root; run git worktree repair"
  recorded="$(cat "$git_dir/gitdir" 2> /dev/null || true)"
  recorded_parent="$(cd "$(dirname "$recorded")" 2> /dev/null && pwd -P || true)"
  # A moved worktree keeps the old path in `gitdir`, and then the scanner skips every file with no error.
  [ -n "$recorded" ] && [ "$recorded_parent" = "$repo_root" ] ||
    fail "The git directory of the worktree records '${recorded:-nothing}' but the worktree is at '$repo_root'; run git worktree repair"
  common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
  repo_mount="$repo_root:$repo_root:ro"
  base_dir_args=("-Dsonar.projectBaseDir=$repo_root")
  git_args=(-v "$common_dir:$common_dir:ro")
  # With an earlier mount layout, the git ignore filter of the scanner dropped every file of a worktree. The flag
  # stays, because no test shows that the current layout is safe without it. The exclusions of the config still apply.
  scm_args=(-Dsonar.scm.exclusions.disabled=true)
fi

# The memory has a cap and no swap: a type-aware scan without a cap grows past 4 GB and can push the host into swap.
# The Node heap cap keeps the JS/TS analyzer inside the container limit. The scanner home is the mounted cache,
# because the home of the image is open only to uid 1000.
docker run --rm --label "$label" ${network_args[@]+"${network_args[@]}"} -u "$(id -u):$(id -g)" \
  --memory "$scanner_memory" --memory-swap "$scanner_memory" \
  -e SONAR_TOKEN -e "SONAR_HOST_URL=$host_url" -e SONAR_USER_HOME=/tmp/.sonar \
  -v "$repo_mount" -v "$work_dir:/tmp/.scannermeta" -v "$cache_dir:/tmp/.sonar" \
  ${git_args[@]+"${git_args[@]}"} \
  "$scanner_image" \
  "-Dsonar.projectKey=$project" "-Dsonar.projectName=$project" \
  "-Dsonar.projectVersion=$version" \
  ${optional_args[@]+"${optional_args[@]}"} \
  "-Dsonar.javascript.node.maxspace=$node_maxspace_mb" \
  ${base_dir_args[@]+"${base_dir_args[@]}"} \
  -Dsonar.scm.disabled=false ${scm_args[@]+"${scm_args[@]}"} \
  -Dsonar.working.directory=/tmp/scanner-work -Dsonar.scanner.metadataFilePath=/tmp/.scannermeta/report-task.txt

report_task="$work_dir/report-task.txt"
[ -s "$report_task" ] || fail "Scanner finished but produced no report-task.txt"
ce_task_id="$(sed -n 's/^ceTaskId=//p' "$report_task" | tr -d '[:space:]')"
[ -n "$ce_task_id" ] || fail "ceTaskId not found in report-task.txt"

base_url="$(sonar_host_url)"
# The token goes through a curl config on stdin, so it never appears in the process list.
api_get() {
  local path="$1"
  shift
  printf 'user = "%s:"\n' "$SONAR_TOKEN" | curl -sS --max-time 20 -K - -G "$base_url$path" "$@"
}

max_wait=300
waited=0
status=""
echo "Waiting for the server to process analysis $ce_task_id (up to ${max_wait}s)"
while [ "$waited" -lt "$max_wait" ]; do
  status="$(api_get /api/ce/task --data-urlencode "id=$ce_task_id" 2> /dev/null | jq -r '.task.status // empty' 2> /dev/null || true)"
  case "$status" in
    SUCCESS) break ;;
    FAILED | CANCELED) fail "Server analysis task $ce_task_id ended $status; see $base_url/project/background_tasks" ;;
  esac
  sleep 1
  waited=$((waited + 1))
done
[ "$status" = "SUCCESS" ] || fail "Server did not finish processing $ce_task_id within ${max_wait}s (last status: ${status:-unknown})"
echo "Analysis processed in about ${waited}s"

gate="$(api_get /api/qualitygates/project_status --data-urlencode "projectKey=$project")" || fail "Could not read the quality gate status"
echo "Quality gate: $(jq -r '.projectStatus.status // "UNKNOWN"' <<< "$gate")"
echo "New code period: $(jq -r '.projectStatus.period | if . then "mode=\(.mode // "-") date=\(.date // "-") parameter=\(.parameter // "-")" else "not reported" end' <<< "$gate")"
jq -r '.projectStatus.conditions[]? | "  \(.metricKey) \(.status) (actual \(.actualValue // "-"), error at \(.errorThreshold // "-"))"' <<< "$gate"
