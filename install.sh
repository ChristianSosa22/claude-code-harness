#!/usr/bin/env bash
# Links every file under user/ into ~/.claude at the same relative path. Idempotent.
# Usage: ./install.sh
set -euo pipefail

harness="$(cd "$(dirname "$0")" && pwd)"
target="$HOME/.claude"
backup="$target/backups/harness-$(date +%Y%m%d-%H%M%S)"

cd "$harness/user"
find . -type f ! -name '.DS_Store' | sed 's#^\./##' | sort | while IFS= read -r file; do
  source_file="$harness/user/$file"
  link="$target/$file"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$source_file" ]; then
    echo "ok       $file"
    continue
  fi
  mkdir -p "$(dirname "$link")"
  if [ -e "$link" ] || [ -L "$link" ]; then
    mkdir -p "$backup/$(dirname "$file")"
    mv "$link" "$backup/$file"
    echo "backup   $file -> $backup/$file"
  fi
  ln -s "$source_file" "$link"
  echo "linked   $file"
done

bin_dir="${HARNESS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
for tool in "$harness"/tools/*; do
  [ -f "$tool" ] && [ -x "$tool" ] || continue
  name="$(basename "$tool")"
  name="${name%.*}"
  link="$bin_dir/$name"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$tool" ]; then
    echo "ok       bin/$name"
    continue
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "SKIP     bin/$name: $link exists and is not a link to the harness"
    continue
  fi
  ln -s "$tool" "$link"
  echo "linked   bin/$name -> $link"
done
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "WARNING: $bin_dir is not on PATH; add it to your shell profile to run the tools by name." ;;
esac

