#!/usr/bin/env bash
set -euo pipefail

# Dump the shared Rust engine's computed geometry for real CIFP procedures,
# end to end: extract the procedures with extract_geometry.ts, append the
# generated temporary test to approach_path/tests.rs, run it, and restore
# tests.rs afterwards (even on failure), leaving only the segments files and
# procedures.json under --out-dir.
#
# Usage (from the repo root):
#   dump_geometry.sh <ICAO>:<PROC_ID> [<ICAO>:<PROC_ID> ...] [--out-dir <dir>]
#   dump_geometry.sh KACK                       # list an airport's procedures
#
# Examples:
#   dump_geometry.sh KACK:S24 KDDC:I14
#   dump_geometry.sh KACK:S24 --out-dir .tmp/plate-visual-check/geometry
#
# The segments files pair with overlay_geometry.py / plot_geometry.py; see
# procedures.json for the per-procedure projection reference and a ready-to-run
# overlay command.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cd "$repo_root"

out_dir=".tmp/plate-visual-check/geometry"
extract_args=()
has_spec=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    -h|--help) sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      case "$1" in *:*) has_spec=1 ;; esac
      extract_args+=("$1"); shift ;;
  esac
done

if [ "${#extract_args[@]}" -eq 0 ]; then
  echo "Usage: dump_geometry.sh <ICAO>:<PROC_ID> [...] | <ICAO> [--out-dir <dir>]" >&2
  exit 1
fi

npx tsx "$script_dir/extract_geometry.ts" "${extract_args[@]}" --out-dir "$out_dir"

# List-only invocation: nothing to dump.
if [ -z "$has_spec" ]; then
  exit 0
fi

tests_rs="crates/approach-viz-core/src/approach_path/tests.rs"
backup="$(mktemp)"
cp "$tests_rs" "$backup"
restore() { cp "$backup" "$tests_rs"; rm -f "$backup"; }
trap restore EXIT

cat "$out_dir/dump_plate_geometry.rs" >> "$tests_rs"
cargo test -p approach-viz-core dump_plate_geometry -- --nocapture

echo "Segments files and procedures.json are under $out_dir" >&2
