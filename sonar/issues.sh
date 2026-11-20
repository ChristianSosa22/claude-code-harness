#!/usr/bin/env bash
# Lists the unresolved issues of a project in a given set of files, with no regard to the new code period.
# Output: "rule path:line message", then a count. The analysis token comes from SONAR_TOKEN_FILE.
# Usage: sonar/issues.sh <project-key> <files-list>
#   <files-list>: text file with one repo-relative path per line.
set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_tools jq curl

[ "$#" -eq 2 ] || fail "Usage: issues.sh <project-key> <files-list>"
project="$1"
files_list="$2"
[ -f "$files_list" ] || fail "Files list not found: $files_list"

token="$(read_token "${SONAR_TOKEN_FILE:-$SONAR_DEFAULT_TOKEN_FILE}")"
base_url="$(sonar_host_url)"
page_size=500

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# The token goes through a curl config on stdin, so it never appears in the process list.
page=1
while :; do
  code="$(printf 'user = "%s:"\n' "$token" |
    curl -sS -K - -G -o "$work_dir/page.json" -w '%{http_code}' "$base_url/api/issues/search" \
      --data-urlencode "componentKeys=$project" --data-urlencode "resolved=false" \
      --data-urlencode "ps=$page_size" --data-urlencode "p=$page")"
  [ "$code" -lt 400 ] || fail "issues/search -> HTTP $code: $(jq -r '[.errors[]?.msg] | join("; ")' "$work_dir/page.json" 2> /dev/null || true)"
  jq -c '.issues[]' "$work_dir/page.json" >> "$work_dir/all.jsonl"
  total="$(jq -r '.paging.total' "$work_dir/page.json")"
  [ $((page * page_size)) -lt "$total" ] || break
  page=$((page + 1))
done
touch "$work_dir/all.jsonl"

jq -r --rawfile files "$files_list" --arg project "$project" '
  ($files | split("\n") | map(select(length > 0))) as $wanted
  | select(.component | ltrimstr($project + ":") | IN($wanted[]))
  | "\(.rule | sub("^[a-z]+:"; "")) \(.component | ltrimstr($project + ":")):\(.line // 0) \(.message)"' \
  "$work_dir/all.jsonl" | sort > "$work_dir/out.txt"

cat "$work_dir/out.txt"
echo "Issues: $(wc -l < "$work_dir/out.txt" | tr -d ' ')"
