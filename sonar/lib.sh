#!/usr/bin/env bash
# Shared helpers of the SonarQube kit. Sourced, not executed. Needs bash 3.2+, jq, and curl.

SONAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The config can live outside the clone, so that one employer's rules never enter this repository.
SONAR_CONFIG="${SONAR_CONFIG:-$SONAR_DIR/config.json}"
SONAR_DEFAULT_TOKEN_FILE="$HOME/.config/sonar-group/token"
SONAR_DEFAULT_ADMIN_TOKEN_FILE="$HOME/.config/sonar-group/admin-token"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" > /dev/null 2>&1 || fail "Missing required tool: $tool"
  done
  [ -s "$SONAR_CONFIG" ] || fail "Missing config: $SONAR_CONFIG (copy config.example.json, or set SONAR_CONFIG)"
}

# cfg <jq-filter> [jq args]: prints a raw value from the config.
cfg() {
  local filter="$1"
  shift
  jq -r "$@" "$filter" "$SONAR_CONFIG"
}

sonar_port() { cfg '.server.port'; }

sonar_host_url() { echo "http://127.0.0.1:$(sonar_port)"; }

# project_cfg <project-key>: the defaults merged with the project entry, with extra_issue_exclusions appended.
project_cfg() {
  local key="$1"
  jq -e --arg k "$key" '
    if (.projects[$k] | type) == "object" then
      (.defaults * .projects[$k])
      | .issue_exclusions = ((.issue_exclusions // []) + (.extra_issue_exclusions // []))
      | del(.extra_issue_exclusions)
    else
      error("unknown project")
    end' "$SONAR_CONFIG" 2> /dev/null || fail "Project '$key' is not declared in $SONAR_CONFIG (.projects)"
}

# read_token <file>: prints the token without whitespace.
read_token() {
  local file="$1"
  [ -s "$file" ] || fail "Token file not found or empty: $file (see sonar/README.md)"
  tr -d '[:space:]' < "$file"
}

# wait_for_sonar [max-seconds]: returns when api/system/status is UP.
wait_for_sonar() {
  local max="${1:-240}" waited=0 status=""
  while [ "$waited" -lt "$max" ]; do
    status="$(curl -sS --max-time 5 "$(sonar_host_url)/api/system/status" 2> /dev/null | jq -r '.status // empty' 2> /dev/null || true)"
    [ "$status" = "UP" ] && return 0
    sleep 3
    waited=$((waited + 3))
  done
  fail "SonarQube did not reach UP within ${max}s (last status: ${status:-unreachable})"
}
