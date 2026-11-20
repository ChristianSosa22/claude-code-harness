#!/usr/bin/env bash
# Applies the config to the running SonarQube. A second run changes nothing. It sets the project, the quality profile
# (parent and rules with parameters), the quality gate (conditions), the issue exclusions, and the new code period.
# It needs a User Token of an admin (see sonar/README.md) in SONAR_ADMIN_TOKEN_FILE.
# Usage: sonar/apply.sh <project-key>
set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_tools jq curl

[ "$#" -eq 1 ] || fail "Usage: apply.sh <project-key>"
project="$1"
settings="$(project_cfg "$project")"

admin_token="$(read_token "${SONAR_ADMIN_TOKEN_FILE:-$SONAR_DEFAULT_ADMIN_TOKEN_FILE}")"
base_url="$(sonar_host_url)"
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# sonar_call <GET|POST> <endpoint> [curl args...]: prints the response body, fails on HTTP >= 400.
# The token goes through a curl config on stdin so it never appears in the process list.
sonar_call() {
  local method="$1" endpoint="$2" code
  shift 2
  if [ "$method" = "GET" ]; then
    code="$(printf 'user = "%s:"\n' "$admin_token" |
      curl -sS -K - -G -o "$body_file" -w '%{http_code}' "$base_url/api/$endpoint" "$@")"
  else
    code="$(printf 'user = "%s:"\n' "$admin_token" |
      curl -sS -K - -X POST -o "$body_file" -w '%{http_code}' "$base_url/api/$endpoint" "$@")"
  fi
  if [ "$code" -ge 400 ]; then
    fail "$method $endpoint -> HTTP $code: $(jq -r '[.errors[]?.msg] | join("; ")' "$body_file" 2> /dev/null || true)"
  fi
  cat "$body_file"
}
get() { sonar_call GET "$@"; }
post() { sonar_call POST "$@" > /dev/null; }

wait_for_sonar 30

if [ "$(get projects/search --data-urlencode "projects=$project" | jq -r '.components | length')" = "0" ]; then
  post projects/create --data-urlencode "project=$project" --data-urlencode "name=$project"
  echo "Created project $project"
fi

profile_name="$(cfg '.profile.name')"
profile_lang="$(cfg '.profile.language')"
profile_parent="$(cfg '.profile.parent')"
profile_repo="$(cfg '.profile.repository')"

profile_key="$(get qualityprofiles/search --data-urlencode "language=$profile_lang" |
  jq -r --arg n "$profile_name" '.profiles[] | select(.name == $n) | .key')"
if [ -z "$profile_key" ]; then
  post qualityprofiles/create --data-urlencode "name=$profile_name" --data-urlencode "language=$profile_lang"
  profile_key="$(get qualityprofiles/search --data-urlencode "language=$profile_lang" |
    jq -r --arg n "$profile_name" '.profiles[] | select(.name == $n) | .key')"
  echo "Created profile $profile_name"
fi
post qualityprofiles/change_parent --data-urlencode "language=$profile_lang" \
  --data-urlencode "qualityProfile=$profile_name" --data-urlencode "parentQualityProfile=$profile_parent"
while IFS=$'\t' read -r rule params; do
  post qualityprofiles/activate_rule --data-urlencode "key=$profile_key" \
    --data-urlencode "rule=$profile_repo:$rule" --data-urlencode "params=$params"
done < <(cfg '.profile.rules[] | [.rule, .params] | @tsv')
# Rules the profile no longer redefines inherit the parent's severity and parameters. A rule still carrying an own
# override (inheritance OVERRIDES: active in the parent and changed here) that is not in .profile.rules is reset to
# the parent's values (`reset=true`).
declared_rules="$(cfg '[.profile.rules[].rule] | join(" ")')"
while IFS= read -r override_key; do
  [ -n "$override_key" ] || continue
  case " $declared_rules " in *" ${override_key#*:} "*) continue ;; esac
  post qualityprofiles/activate_rule --data-urlencode "key=$profile_key" \
    --data-urlencode "rule=$override_key" --data-urlencode "reset=true"
  echo "Reset to the parent's value: $override_key"
done < <(get rules/search --data-urlencode "qprofile=$profile_key" --data-urlencode "activation=true" \
  --data-urlencode "inheritance=OVERRIDES" --data-urlencode "ps=500" | jq -r '.rules[]?.key')
# Rules the profile must not carry. A rule that is not active is skipped (checked first, so the run stays idempotent);
# an inherited one cannot be deactivated here and the API error stops the run.
while IFS= read -r rule; do
  [ -n "$rule" ] || continue
  if [ "$(get rules/search --data-urlencode "qprofile=$profile_key" --data-urlencode "activation=true" \
    --data-urlencode "rule_key=$profile_repo:$rule" | jq -r '.total')" != "0" ]; then
    post qualityprofiles/deactivate_rule --data-urlencode "key=$profile_key" \
      --data-urlencode "rule=$profile_repo:$rule"
    echo "Deactivated: $profile_repo:$rule"
  fi
done < <(cfg '.profile.deactivated_rules[]?')
post qualityprofiles/add_project --data-urlencode "language=$profile_lang" \
  --data-urlencode "qualityProfile=$profile_name" --data-urlencode "project=$project"

gate_name="$(cfg '.gate.name')"
if ! get qualitygates/list | jq -e --arg n "$gate_name" '.qualitygates[] | select(.name == $n)' > /dev/null; then
  post qualitygates/create --data-urlencode "name=$gate_name"
  echo "Created gate $gate_name"
fi
while IFS=$'\t' read -r metric op error; do
  current="$(get qualitygates/show --data-urlencode "name=$gate_name" |
    jq -c --arg m "$metric" '[.conditions[]? | select(.metric == $m)][0] // empty')"
  if [ -z "$current" ]; then
    post qualitygates/create_condition --data-urlencode "gateName=$gate_name" \
      --data-urlencode "metric=$metric" --data-urlencode "op=$op" --data-urlencode "error=$error"
  elif [ "$(jq -r '.op + " " + .error' <<< "$current")" != "$op $error" ]; then
    post qualitygates/update_condition --data-urlencode "id=$(jq -r .id <<< "$current")" \
      --data-urlencode "metric=$metric" --data-urlencode "op=$op" --data-urlencode "error=$error"
  fi
done < <(cfg '.gate.conditions[] | [.metric, .op, .error] | @tsv')
while IFS= read -r metric; do
  [ -n "$metric" ] || continue
  for condition_id in $(get qualitygates/show --data-urlencode "name=$gate_name" |
    jq -r --arg m "$metric" '.conditions[]? | select(.metric == $m) | .id'); do
    post qualitygates/delete_condition --data-urlencode "id=$condition_id"
  done
done < <(cfg '.gate.remove_metrics[]?')
post qualitygates/select --data-urlencode "gateName=$gate_name" --data-urlencode "projectKey=$project"

exclusion_args=()
while IFS= read -r field_value; do
  exclusion_args+=(--data-urlencode "fieldValues=$field_value")
done < <(jq -c --arg repo "$profile_repo" \
  '.issue_exclusions[] | {ruleKey: ($repo + ":" + .rule), resourceKey: .resource}' <<< "$settings")
if [ "${#exclusion_args[@]}" -gt 0 ]; then
  post settings/set --data-urlencode "component=$project" \
    --data-urlencode "key=sonar.issue.ignore.multicriteria" "${exclusion_args[@]}"
else
  post settings/reset --data-urlencode "component=$project" \
    --data-urlencode "keys=sonar.issue.ignore.multicriteria"
fi

period_type="$(jq -r .new_code_period <<< "$settings")"
if [ "$period_type" = "SPECIFIC_ANALYSIS" ]; then
  # Pinned baseline: `baseline_version` is the VERSION event of the analysis to pin, `<name>-<short sha>`; the analysis
  # must also carry that commit as its revision, so a branch scan reusing the version is never taken for the baseline.
  # No analysis key lives in the config: it is resolved here on every run, so the result survives a recreated server.
  baseline_version="$(jq -r '.baseline_version // empty' <<< "$settings")"
  baseline_sha="${baseline_version##*-}"
  case "$baseline_sha" in
    '' | *[!0-9a-f]*) fail "baseline_version '$baseline_version' of $project must end with -<commit sha> in lowercase hex" ;;
  esac
  [ "${#baseline_sha}" -ge 7 ] || fail "baseline_version '$baseline_version' of $project must end with at least 7 hex characters of the commit"
  baseline_key="$(get project_analyses/search --data-urlencode "project=$project" --data-urlencode "category=VERSION" \
    --data-urlencode "ps=500" |
    jq -r --arg v "$baseline_version" --arg sha "$baseline_sha" '
      [.analyses[] | select((.revision // "") | startswith($sha))
        | select(any(.events[]?; .category == "VERSION" and .name == $v))]
      | sort_by(.date) | .[0].key // empty')"
  [ -n "$baseline_key" ] ||
    fail "No analysis of $project has VERSION $baseline_version with revision $baseline_sha; scan commit $baseline_sha with version $baseline_version first (scan.sh $project <clean worktree at $baseline_sha> $baseline_version). The stored new code period is unchanged"
  post new_code_periods/set --data-urlencode "project=$project" \
    --data-urlencode "type=SPECIFIC_ANALYSIS" --data-urlencode "value=$baseline_key"
  # Verify through `list` (main branch row): `show` without a branch reports the inherited PREVIOUS_VERSION in CE.
  main_branch="$(get project_branches/list --data-urlencode "project=$project" |
    jq -r '[.branches[] | select(.isMain)][0].name // empty')"
  [ -n "$main_branch" ] || fail "Main branch of $project not found"
  stored="$(get new_code_periods/list --data-urlencode "project=$project" |
    jq -r --arg b "$main_branch" '[.newCodePeriods[] | select(.branchKey == $b)][0] | "\(.type // "-") \(.value // "-")"')"
  [ "$stored" = "SPECIFIC_ANALYSIS $baseline_key" ] ||
    fail "New code period of $project not stored as expected (found: $stored; expected: SPECIFIC_ANALYSIS $baseline_key)"
  echo "New code period: SPECIFIC_ANALYSIS $baseline_version (analysis $baseline_key)"
else
  post new_code_periods/set --data-urlencode "project=$project" \
    --data-urlencode "type=$period_type"
fi

echo "Project:  $project"
get qualityprofiles/search --data-urlencode "project=$project" |
  jq -r --arg l "$profile_lang" '.profiles[] | select(.language == $l) | "Profile:  \(.name) (\(.activeRuleCount) active rules)"'
get qualitygates/get_by_project --data-urlencode "project=$project" | jq -r '"Gate:     \(.qualityGate.name)"'
get qualitygates/show --data-urlencode "name=$gate_name" |
  jq -r '.conditions[] | "          \(.metric) \(.op) \(.error)"'
echo "Issue exclusions: $(jq '.issue_exclusions | length' <<< "$settings")"
