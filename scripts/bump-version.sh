#!/usr/bin/env bash
set -euo pipefail

# Bump version, commit, push, and trigger a GitHub release.
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

# package.json (first "version" line only, via awk to avoid macOS sed issues)
awk -v old="$current" -v new="$new" '!done && /"version":/ { sub(old, new); done=1 } 1' package.json > package.json.tmp && mv package.json.tmp package.json

# tauri.conf.json
sed -i '' "s/\"version\": \"$current\"/\"version\": \"$new\"/" src-tauri/tauri.conf.json

# Cargo.toml (top-level version only)
sed -i '' "s/^version = \"$current\"/version = \"$new\"/" src-tauri/Cargo.toml

# package-lock.json + Cargo.lock
npm install --package-lock-only --silent 2>/dev/null
(cd src-tauri && cargo generate-lockfile --quiet 2>/dev/null) || true

echo "Bumped to $new"

# Commit and push
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore: bump version to v$new"
git push

# Trigger release workflow
echo "Triggering release workflow..."
gh workflow run release.yml
echo "Release triggered — check https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"
