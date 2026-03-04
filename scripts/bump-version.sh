#!/usr/bin/env bash
set -euo pipefail

# Bump version across all project files: package.json, package-lock.json,
# Cargo.toml, and tauri.conf.json.
#
# Usage:
#   ./scripts/bump-version.sh patch   # 0.11.2 -> 0.11.3
#   ./scripts/bump-version.sh minor   # 0.11.2 -> 0.12.0
#   ./scripts/bump-version.sh major   # 0.11.2 -> 1.0.0
#   ./scripts/bump-version.sh 1.2.3   # set exact version

cd "$(git rev-parse --show-toplevel)"

current=$(grep -o '"version": "[^"]*"' package.json | head -1 | cut -d'"' -f4)
IFS='.' read -r major minor patch <<< "$current"

case "${1:-}" in
  patch) new="$major.$minor.$((patch + 1))" ;;
  minor) new="$major.$((minor + 1)).0" ;;
  major) new="$((major + 1)).0.0" ;;
  [0-9]*) new="$1" ;;
  *) echo "Usage: $0 <patch|minor|major|X.Y.Z>"; exit 1 ;;
esac

echo "$current -> $new"

# package.json (first occurrence only)
sed -i '' "0,/\"version\": \"$current\"/s//\"version\": \"$new\"/" package.json

# tauri.conf.json
sed -i '' "s/\"version\": \"$current\"/\"version\": \"$new\"/" src-tauri/tauri.conf.json

# Cargo.toml (top-level version only)
sed -i '' "s/^version = \"$current\"/version = \"$new\"/" src-tauri/Cargo.toml

# package-lock.json + Cargo.lock
npm install --package-lock-only --silent 2>/dev/null
(cd src-tauri && cargo generate-lockfile --quiet 2>/dev/null) || true

echo "Bumped to $new"
