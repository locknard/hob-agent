#!/bin/sh

set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

expected=$(find contracts packages -type f -name '*.test.ts' \
  -not -path '*/node_modules/*' -print | LC_ALL=C sort)
actual=""
if [ -f tests/run-typescript-tests.sh ]; then
  actual=$(sh tests/run-typescript-tests.sh --list)
fi

if [ "$actual" != "$expected" ]; then
  echo "TypeScript test discovery must include every nested test file" >&2
  exit 1
fi
