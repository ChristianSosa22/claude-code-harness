#!/usr/bin/env bash
# Copies project-template/ into a repository. It never overwrites a file that exists.
# Usage: ./new-project.sh <repo-root>
set -euo pipefail

[ "$#" -eq 1 ] && [ -d "$1" ] || { echo "Usage: new-project.sh <repo-root>" >&2; exit 1; }
harness="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$1" && pwd)"

cd "$harness/project-template"
find . -type d -name node_modules -prune -o -type f ! -name '.DS_Store' -print | sed 's#^\./##' | sort | while IFS= read -r file; do
  if [ -e "$repo/$file" ]; then
    echo "skip     $file (exists)"
    continue
  fi
  mkdir -p "$repo/$(dirname "$file")"
  cp "$file" "$repo/$file"
  echo "copied   $file"
done

echo
echo "Next: run 'openspec init' in $repo, fill the <...> placeholders in CLAUDE.md and openspec/config.yaml,"
echo "and add \"harness:metrics\": \"npx tsx scripts/harness-metrics.ts\" to package.json."
