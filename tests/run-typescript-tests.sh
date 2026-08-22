#!/bin/sh

set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

if [ "${1:-}" = "--list" ]; then
  find contracts packages -type f -name '*.test.ts' -print | LC_ALL=C sort
  exit 0
fi

find contracts packages -type f -name '*.test.ts' \
  -exec env NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx --test {} +
