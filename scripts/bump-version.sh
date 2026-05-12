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
npm install --package-lock-only --silent
# Use `cargo update --workspace`, not `cargo generate-lockfile` — the latter
# re-resolves git deps from scratch and can spuriously fail when an upstream
# git dep's HEAD has moved.
(cd src-tauri && cargo update --workspace --quiet)

# Verify the lockfiles actually picked up the new version.
if ! grep -q "\"version\": \"$new\"" package-lock.json; then
  echo "ERROR: package-lock.json was not updated to $new" >&2
  exit 1
fi
if ! awk '/^name = "talky"$/{found=1; next} found && /^version =/{print; exit}' src-tauri/Cargo.lock | grep -q "\"$new\""; then
  echo "ERROR: src-tauri/Cargo.lock talky entry was not updated to $new" >&2
  exit 1
fi

echo "Bumped to $new"

# Commit and push
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore: bump version to v$new"
git push

# Trigger release workflow
echo "Triggering release workflow..."
gh workflow run release.yml
echo "Release triggered — check https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"

cat <<NOTE

================================================================
  NEXT STEP: WRITE USER-FACING RELEASE NOTES FOR v$new
================================================================
  The release workflow creates a DRAFT with auto-generated commit-
  message notes. Replace them with proper user-facing notes before
  publishing:

    gh release view  v$new
    gh release edit  v$new --notes "..."

  Match the style of the previous release (gh release view v$current).
  If running under Claude Code, write the notes now — don't stop
  at "release triggered".
================================================================
NOTE
