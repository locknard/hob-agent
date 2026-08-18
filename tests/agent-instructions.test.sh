#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/scripts"
cp "$repo_root/scripts/sync-agent-instructions.sh" "$temp_dir/scripts/"

cat > "$temp_dir/CLAUDE.md" <<'EOF'
# Project instructions

The canonical instructions live here.
EOF

cat > "$temp_dir/AGENTS.md" <<'EOF'
# stale instructions
EOF

if (cd "$temp_dir" && sh scripts/sync-agent-instructions.sh --check >/dev/null 2>&1); then
  echo "expected --check to reject stale AGENTS.md" >&2
  exit 1
fi

(cd "$temp_dir" && sh scripts/sync-agent-instructions.sh)

cmp "$temp_dir/CLAUDE.md" "$temp_dir/AGENTS.md"
(cd "$temp_dir" && sh scripts/sync-agent-instructions.sh --check)
