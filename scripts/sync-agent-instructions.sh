#!/bin/sh
set -eu

source_file=CLAUDE.md
target_file=AGENTS.md

if [ ! -f "$source_file" ]; then
  echo "Missing canonical instruction file: $source_file" >&2
  exit 1
fi

case "${1:-}" in
  "")
    cp "$source_file" "$target_file"
    ;;
  --check)
    if [ ! -f "$target_file" ] || ! cmp -s "$source_file" "$target_file"; then
      echo "$target_file is out of sync with $source_file. Run: pnpm sync:agents" >&2
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac
