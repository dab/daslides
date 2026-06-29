#!/usr/bin/env bash
#
# Convert RAW + TIFF files to high-quality JPEGs (longest edge 2560 px).
#
# Pipeline:
#   1. Try `sips` first  — macOS's built-in ImageIO RAW decoder (the same
#      pipeline Preview/Photos/Quick Look use). Full debayer + color profile
#      + Apple's default WB, very fast on Apple Silicon.
#   2. If `sips` fails AND LibRaw is installed (`brew install libraw`), retry
#      with `dcraw_emu -T -w` → produces a 16-bit TIFF → pipe through sips
#      to JPEG. Catches the rare corrupt-EXIF / unusual-variant cases that
#      Apple's ImageIO rejects.
#
# Apple ships RAW Camera Support updates only inside macOS point releases now —
# no separate beta channel exists. Keep macOS current to pick up new bodies.
# Check what's installed:
#   bash scripts/raw-version.sh
#
# Usage:
#   bash scripts/raw-to-jpeg.sh <input-folder> [output-folder]
#
# Default output: <input-folder>/_converted
#
# Idempotent. Preserves directory structure. Sequential.

set -uo pipefail

if [ $# -lt 1 ]; then
  cat <<USAGE
Usage: $0 <input-folder> [output-folder]

Converts every CR2, CR3, NEF, ARW, RAF, RW2, ORF, DNG, TIF, TIFF in the
input folder (recursively) to JPEG at max quality, longest edge 2560 px.

Default output:  <input-folder>/_converted
USAGE
  exit 1
fi

INPUT="${1%/}"
OUTPUT="${2:-$INPUT/_converted}"
MAX_DIM=2560

if [ ! -d "$INPUT" ]; then
  echo "Input folder not found: $INPUT" >&2
  exit 1
fi

if ! command -v sips > /dev/null 2>&1; then
  echo "sips not found — this script requires macOS." >&2
  exit 1
fi

HAS_DCRAW=0
if command -v dcraw_emu > /dev/null 2>&1; then
  HAS_DCRAW=1
fi

mkdir -p "$OUTPUT"
abs_input="$(cd "$INPUT" && pwd)"
abs_output="$(cd "$OUTPUT" && pwd)"

echo "Input:   $abs_input"
echo "Output:  $abs_output"
echo "Max dim: ${MAX_DIM} px (longest edge), quality: best"
if [ "$HAS_DCRAW" = "1" ]; then
  echo "Fallback: LibRaw dcraw_emu (for files sips rejects)"
else
  echo "Fallback: none — install with 'brew install libraw' to catch sips failures"
fi
echo ""

count=0
skipped=0
failed=0
fallback_count=0
total=0

# Count first
while IFS= read -r -d '' file; do
  total=$((total + 1))
done < <(find "$abs_input" -type f \
  ! -path "$abs_output/*" \
  \( -iname '*.cr2' -o -iname '*.cr3' -o \
     -iname '*.nef' -o -iname '*.arw' -o \
     -iname '*.raf' -o -iname '*.rw2' -o \
     -iname '*.orf' -o -iname '*.dng' -o \
     -iname '*.tif' -o -iname '*.tiff' \
  \) -print0)

if [ "$total" -eq 0 ]; then
  echo "No RAW/TIFF files found under $abs_input"
  exit 1
fi

echo "Found $total file(s) to consider."
echo ""

# Convert one file. Returns 0 on success, non-zero on failure.
# Tries sips first; falls back to dcraw_emu+sips if sips fails and dcraw is available.
convert_one() {
  local src="$1" dst="$2"
  if sips -s format jpeg -s formatOptions best -Z "$MAX_DIM" \
         "$src" --out "$dst" > /dev/null 2>&1; then
    return 0
  fi
  rm -f "$dst" 2>/dev/null || true

  # sips failed — try LibRaw if available
  if [ "$HAS_DCRAW" = "1" ]; then
    local tmp
    tmp="$(mktemp -t rawconv).tiff"
    if dcraw_emu -T -w -o 1 -q 3 -Z "$tmp" "$src" > /dev/null 2>&1 \
       && [ -f "$tmp" ]; then
      if sips -s format jpeg -s formatOptions best -Z "$MAX_DIM" \
             "$tmp" --out "$dst" > /dev/null 2>&1; then
        rm -f "$tmp"
        return 10  # success via fallback (distinct exit so we can count it)
      fi
    fi
    rm -f "$tmp" 2>/dev/null || true
  fi
  return 1
}

i=0
while IFS= read -r -d '' file; do
  i=$((i + 1))
  rel="${file#$abs_input/}"
  reldir="$(dirname "$rel")"
  base="$(basename "$rel")"
  stem="${base%.*}"

  if [ "$reldir" = "." ]; then
    outfile="$abs_output/${stem}.jpg"
  else
    outfile="$abs_output/$reldir/${stem}.jpg"
  fi

  if [ -f "$outfile" ]; then
    skipped=$((skipped + 1))
    printf '  [%4d/%d] SKIP  %s (exists)\n' "$i" "$total" "$rel"
    continue
  fi

  mkdir -p "$(dirname "$outfile")"
  convert_one "$file" "$outfile"
  rc=$?
  case "$rc" in
    0)  count=$((count + 1));          printf '  [%4d/%d] OK     %s\n' "$i" "$total" "$rel" ;;
    10) count=$((count + 1)); fallback_count=$((fallback_count + 1))
        printf '  [%4d/%d] OK*    %s  (via LibRaw)\n' "$i" "$total" "$rel" ;;
    *)  failed=$((failed + 1));        printf '  [%4d/%d] FAIL   %s\n' "$i" "$total" "$rel" ;;
  esac
done < <(find "$abs_input" -type f \
  ! -path "$abs_output/*" \
  \( -iname '*.cr2' -o -iname '*.cr3' -o \
     -iname '*.nef' -o -iname '*.arw' -o \
     -iname '*.raf' -o -iname '*.rw2' -o \
     -iname '*.orf' -o -iname '*.dng' -o \
     -iname '*.tif' -o -iname '*.tiff' \
  \) -print0)

echo ""
echo "Done."
echo "  Converted: $count   (of which $fallback_count via LibRaw fallback)"
echo "  Skipped:   $skipped (already existed)"
echo "  Failed:    $failed"
echo ""
echo "Output in: $abs_output"

if [ "$failed" -gt 0 ]; then exit 2; fi
exit 0
