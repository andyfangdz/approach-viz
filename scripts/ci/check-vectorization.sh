#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${1:-services/runtime-rs/vectorization-manifest.toml}"
REMARKS_FILE="${2:-target/vectorization-remarks.txt}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi

# Count expected entries
expected_count=$(grep -c '^\[\[expect\]\]' "$MANIFEST" || true)
if [[ "$expected_count" -eq 0 ]]; then
  echo "No vectorization expectations in manifest — skipping check."
  exit 0
fi

# Build with LLVM vectorization remarks (text output to stderr).
# LLVM 21+ removed --pass-remarks-output/--pass-remarks-format; remarks go
# to stderr as text lines:
#   remark: <file>:<line>:<col>: vectorized loop (vectorization width: N, interleaved count: M)
echo "Building with LLVM vectorization remarks..."
RUSTFLAGS="-C llvm-args=--pass-remarks=loop-vectorize \
           ${RUSTFLAGS:-}" \
  cargo build --release -p approach-viz-runtime 2>&1 | tee "$REMARKS_FILE"

# Verify we got some output
if [[ ! -s "$REMARKS_FILE" ]]; then
  echo "ERROR: Remarks file is empty at $REMARKS_FILE" >&2
  exit 1
fi

remark_count=$(grep -c '^remark:' "$REMARKS_FILE" || true)
echo "Found ${remark_count} vectorization remark(s) in build output."

# Parse manifest and check each expectation.
# The "function" field is matched as a grep pattern against the remark text.
# For source-level matching use e.g. function = "processor.rs:43"
# For symbol-level matching (if LLVM emits function names) use the symbol name.
pass=0
fail=0
func="" width="" desc=""

while IFS= read -r line; do
  if [[ "$line" == "[[expect]]" ]]; then
    func="" width="" desc=""
  elif [[ "$line" =~ ^function\ *=\ *\"(.+)\" ]]; then
    func="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^min_width\ *=\ *([0-9]+) ]]; then
    width="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^description\ *=\ *\"(.+)\" ]]; then
    desc="${BASH_REMATCH[1]}"
    # All fields collected — check this expectation
    # Search for a vectorization remark matching the function pattern
    match_line=$(grep "^remark:.*${func}.*vectorized loop" "$REMARKS_FILE" | head -1 || true)
    if [[ -n "$match_line" ]]; then
      # Extract width from "vectorization width: N" using sed (macOS-compatible)
      found_width=$(echo "$match_line" | sed -n 's/.*vectorization width: \([0-9]*\).*/\1/p')
      found_width="${found_width:-0}"
      if [[ "$found_width" -ge "$width" ]]; then
        echo "  PASS: ${func} (width=${found_width} >= ${width})"
        pass=$((pass + 1))
      else
        echo "  FAIL: ${func} — vectorized but width ${found_width} < required ${width}"
        echo "        ${desc}"
        fail=$((fail + 1))
      fi
    else
      echo "  FAIL: ${func} — NOT FOUND in vectorization remarks"
      echo "        ${desc}"
      # Show any missed remarks for this pattern to help debug
      missed=$(grep "^remark:.*${func}.*not vectorized" "$REMARKS_FILE" | head -3 || true)
      if [[ -n "$missed" ]]; then
        echo "        Missed remarks:"
        echo "$missed" | while IFS= read -r m; do echo "          $m"; done
      fi
      fail=$((fail + 1))
    fi
  fi
done < "$MANIFEST"

echo ""
echo "Vectorization check: ${pass} passed, ${fail} failed (of ${expected_count} expected)"

if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "REGRESSION DETECTED: ${fail} loop(s) lost vectorization."
  echo "Check the code changes for branches or type conversions that block LLVM."
  exit 1
fi
