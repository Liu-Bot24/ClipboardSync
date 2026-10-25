#!/bin/bash
# Builds build/ClipboardSync.app from the Swift package.
#
#   Scripts/build-app.sh                     # arm64, ad-hoc signature
#   ARCHS="arm64 x86_64" Scripts/build-app.sh   # universal binary
#   SIGN_IDENTITY="Apple Development: Name (TEAMID)" Scripts/build-app.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ARCHS="${ARCHS:-arm64}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
APP="build/ClipboardSync.app"

arch_flags=()
for arch in $ARCHS; do
  arch_flags+=(--arch "$arch")
done

swift build -c release "${arch_flags[@]}"
bin_dir="$(swift build -c release "${arch_flags[@]}" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$bin_dir/ClipboardSync" "$APP/Contents/MacOS/ClipboardSync"
cp Resources/Info.plist "$APP/Contents/Info.plist"
if [ -f ../assets/ClipboardSync.icns ]; then
  cp ../assets/ClipboardSync.icns "$APP/Contents/Resources/ClipboardSync.icns"
fi

sign_args=(--force --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then
  # Hardened runtime is required for notarization with a Developer ID identity.
  sign_args+=(--options runtime --timestamp)
fi
codesign "${sign_args[@]}" "$APP"
codesign --verify --strict --verbose=2 "$APP"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "Built $APP ($(du -sh "$APP" | cut -f1), archs: $(lipo -archs "$APP/Contents/MacOS/ClipboardSync"))"
