#!/usr/bin/env bash
set -euo pipefail

# Fetch and render an official FAA instrument approach plate (d-TPP) so its plan
# view can be compared against approach-viz's computed geometry.
#
# Resolves the plate PDF from the FAA d-TPP metafile by airport + chart name,
# downloads it, and renders a high-resolution PNG (full page, plus an optional
# clipped plan-view region) for visual inspection.

usage() {
  cat <<'USAGE'
Usage:
  fetch_plate.sh <ICAO> "<chart-name-substring>" [options]

Arguments:
  ICAO                      Airport ICAO id (e.g., KDDC). The 3-letter FAA id
                            (DDC) is also accepted.
  chart-name-substring      Case-insensitive substring of the chart_name, e.g.
                            "ILS OR LOC RWY 14" or "RNAV (GPS) RWY 32".

Options:
  --cycle <YYMM>            d-TPP cycle (e.g., 2606). Default: latest available.
  --out-dir <path>          Output directory (default: .tmp/plate-visual-check/<ICAO>)
  --zoom <n>                Render zoom factor (default: 4 ~= 288 DPI).
  --clip "<x0 y0 x1 y1>"    Optional PDF-point clip box for a plan-view crop,
                            rendered at 1.5x the zoom (e.g., "40 95 320 300").
                            Omit to render the full page only; re-run with a clip
                            once you have read the page coordinates.

Outputs (under --out-dir):
  <plate>.pdf               The downloaded plate.
  <plate>_full.png          Full-page render.
  <plate>_plan.png          Clipped plan-view render (only when --clip given).

Examples:
  fetch_plate.sh KDDC "ILS OR LOC RWY 14"
  fetch_plate.sh KDDC "ILS OR LOC RWY 14" --clip "40 95 320 300"
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 2 ]; then
  usage
  exit "$([ "$#" -lt 2 ] && echo 1 || echo 0)"
fi

icao="$1"; shift
chart_name="$1"; shift
# FAA d-TPP keys airports by the (usually 3-letter) FAA id; strip a leading K.
apt_ident="$icao"
if [ "${#icao}" -eq 4 ] && [ "${icao:0:1}" = "K" ]; then
  apt_ident="${icao:1}"
fi

cycle=""
out_dir=".tmp/plate-visual-check/${icao}"
zoom="4"
clip=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cycle) cycle="$2"; shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    --zoom) zoom="$2"; shift 2 ;;
    --clip) clip="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out_dir"

# Ensure the PDF renderer is available (self-contained, no system poppler needed).
python3 -c "import fitz" >/dev/null 2>&1 || pip install --quiet pymupdf >/dev/null

dtpp_base="https://aeronav.faa.gov/d-tpp"

# Discover the latest cycle from the d-TPP index when not pinned.
if [ -z "$cycle" ]; then
  echo "Discovering latest d-TPP cycle..." >&2
  cycle="$(curl -fsSL "$dtpp_base/" 2>/dev/null \
    | grep -oiE 'href="/d-tpp/[0-9]{4}/"' \
    | grep -oE '[0-9]{4}' \
    | sort -n | tail -1 || true)"
  if [ -z "$cycle" ]; then
    echo "Could not auto-discover the cycle. Pass --cycle YYMM (e.g., 2606)." >&2
    exit 1
  fi
fi
echo "Using d-TPP cycle: $cycle" >&2

# Cache the metafile (it is large; reuse across calls).
metafile="$out_dir/d-TPP_Metafile_${cycle}.xml"
if [ ! -s "$metafile" ]; then
  echo "Fetching d-TPP metafile for cycle $cycle..." >&2
  curl -fsSL "$dtpp_base/$cycle/xml_data/d-TPP_Metafile.xml" -o "$metafile"
fi

pdf_name="$(APT="$apt_ident" CHART="$chart_name" python3 "$script_dir/find_plate.py" "$metafile")"
if [ -z "$pdf_name" ]; then
  echo "No chart matching apt='$apt_ident' name~='$chart_name' in cycle $cycle." >&2
  echo "List candidates with: APT='$apt_ident' CHART='' python3 '$script_dir/find_plate.py' '$metafile'" >&2
  exit 1
fi
echo "Matched plate: $pdf_name" >&2

base="${pdf_name%.PDF}"
pdf_path="$out_dir/${base}.pdf"
curl -fsSL "$dtpp_base/$cycle/$pdf_name" -o "$pdf_path"

python3 "$script_dir/render_plate.py" "$pdf_path" "$out_dir/${base}_full.png" --zoom "$zoom"
echo "Wrote $out_dir/${base}_full.png" >&2

if [ -n "$clip" ]; then
  # shellcheck disable=SC2086
  python3 "$script_dir/render_plate.py" "$pdf_path" "$out_dir/${base}_plan.png" \
    --zoom "$(python3 -c "print($zoom*1.5)")" --clip $clip
  echo "Wrote $out_dir/${base}_plan.png" >&2
fi

# Print the final artifact paths on stdout for the caller to read/View.
echo "$out_dir/${base}_full.png"
[ -n "$clip" ] && echo "$out_dir/${base}_plan.png" || true
