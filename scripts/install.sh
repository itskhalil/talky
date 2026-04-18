#!/bin/bash
set -e

REPO="itskhalil/talky"
APP_NAME="Talky"
INSTALL_DIR="/Applications"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  ARCH_PATTERN="aarch64"
elif [ "$ARCH" = "x86_64" ]; then
  ARCH_PATTERN="x64"
else
  echo "Error: Unsupported architecture: $ARCH"
  exit 1
fi

echo "Detected architecture: $ARCH ($ARCH_PATTERN)"

# Use direct download URL (bypasses GitHub API rate limits)
DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/Talky_${ARCH_PATTERN}.dmg"

echo "Downloading $APP_NAME from $DOWNLOAD_URL..."
if ! curl -fSL -o /tmp/Talky.dmg "$DOWNLOAD_URL"; then
  echo ""
  echo "Error: Failed to download $APP_NAME."
  echo "This could mean:"
  echo "  - No release is available yet"
  echo "  - The DMG for your architecture ($ARCH_PATTERN) is missing"
  echo "  - Network connectivity issues"
  echo ""
  echo "Check releases at: https://github.com/$REPO/releases"
  exit 1
fi

echo "Mounting DMG..."
hdiutil attach /tmp/Talky.dmg -quiet -nobrowse -mountpoint /tmp/talky-mount

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR/$APP_NAME.app"
cp -R "/tmp/talky-mount/$APP_NAME.app" "$INSTALL_DIR/"

echo "Unmounting..."
hdiutil detach /tmp/talky-mount -quiet

echo "Removing quarantine..."
xattr -cr "$INSTALL_DIR/$APP_NAME.app"

rm /tmp/Talky.dmg

echo "Done! $APP_NAME installed to $INSTALL_DIR/$APP_NAME.app"
echo "Launching $APP_NAME..."
open "$INSTALL_DIR/$APP_NAME.app"
