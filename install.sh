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
  ARCH_PATTERN="x86_64"
else
  echo "Error: Unsupported architecture: $ARCH"
  exit 1
fi

echo "Detected architecture: $ARCH ($ARCH_PATTERN)"
echo "Fetching latest release..."
DOWNLOAD_URL=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep "browser_download_url.*${ARCH_PATTERN}.*\.dmg" | head -1 | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: Could not find DMG for $ARCH_PATTERN in latest release"
  exit 1
fi

echo "Downloading $APP_NAME..."
curl -L -o /tmp/Talky.dmg "$DOWNLOAD_URL"

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
