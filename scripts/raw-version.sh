#!/usr/bin/env bash
#
# Show which version of Apple's RAW Camera Support is installed on this Mac,
# and which fallback RAW tools are available.
#
#   bash scripts/raw-version.sh

set -uo pipefail

echo "macOS version:"
sw_vers 2>/dev/null | sed 's/^/  /' || echo "  (not on macOS)"
echo ""

echo "Apple RAW Camera Support bundles:"
for bundle in \
  /System/Library/CoreServices/RawCamera.bundle \
  /System/Library/CoreServices/RawCameraSupport.bundle
do
  if [ -d "$bundle" ]; then
    ver="$(defaults read "$bundle/Contents/Info" CFBundleVersion 2>/dev/null || echo '?')"
    short="$(defaults read "$bundle/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
    echo "  $bundle"
    echo "    bundle version: $ver"
    echo "    short version : $short"
  fi
done
echo ""

echo "  Tip: System Information → Software → RAW Support lists the supported"
echo "       camera models bundled with the current macOS."
echo "  Apple's current camera list: https://support.apple.com/en-us/122870"
echo ""

echo "Built-in CLI:"
if command -v sips > /dev/null 2>&1; then
  echo "  sips      $(sips --version 2>&1 | head -1 || echo present)"
else
  echo "  sips      not found"
fi

echo ""
echo "Optional fallback tools:"
for tool in dcraw_emu darktable-cli rawtherapee-cli exiftool magick; do
  if command -v "$tool" > /dev/null 2>&1; then
    ver="$($tool --version 2>&1 | head -1 || $tool -version 2>&1 | head -1 || echo present)"
    printf '  %-16s %s\n' "$tool" "$ver"
  else
    printf '  %-16s (not installed)\n' "$tool"
  fi
done

echo ""
echo "Install fallback tools if needed:"
echo "  brew install libraw exiftool imagemagick"
echo "  brew install --cask darktable"
