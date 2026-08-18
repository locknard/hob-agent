#!/bin/sh
set -eu

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

configured_path=$(git config --local --get core.hooksPath || true)
if [ -n "$configured_path" ] && [ "$configured_path" != ".githooks" ]; then
  echo "Not changing existing local core.hooksPath: $configured_path" >&2
  exit 0
fi

git config --local core.hooksPath .githooks
