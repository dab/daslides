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
  # sips has no --version; it prints usage. Just report that it's there.
  echo "  sips      present ($(command -v sips))"
else
  echo "  sips      not found"
fi

echo ""
echo "Optional fallback tools:"
for tool in dcraw_emu darktable-cli rawtherapee-cli exiftool magick; do
  if command -v "$tool" > /dev/null 2>&1; then
    # A pipeline's exit status is head's, which always succeeds — so the old
    # `|| fallback` chain here could never run. Try each flag and accept the
    # first line that actually looks like a version (exiftool answers
    # `--version` with its man page, which is where "NAME" came from).
    ver=""
    for flag in -ver --version -version -V; do
      ver="$("$tool" "$flag" 2>/dev/null | head -1)"
      case "$ver" in *[0-9]*) break ;; *) ver="" ;; esac
    done
    [ -n "$ver" ] || ver="present"
    printf '  %-16s %s\n' "$tool" "$ver"
  else
    printf '  %-16s (not installed)\n' "$tool"
  fi
done

echo ""
echo "Install fallback tools if needed:"
echo "  brew install libraw exiftool imagemagick"
echo "  brew install --cask darktable"
