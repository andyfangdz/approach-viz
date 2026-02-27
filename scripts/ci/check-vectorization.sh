#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${1:-services/runtime-rs/vectorization-manifest.toml}"
REMARKS_FILE="${2:-target/vectorization-remarks.yaml}"

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

# Build with LLVM vectorization remarks
echo "Building with LLVM vectorization remarks..."
RUSTFLAGS="-C llvm-args=-pass-remarks=loop-vectorize \
           -C llvm-args=-pass-remarks-output=${REMARKS_FILE} \
           -C llvm-args=-pass-remarks-format=yaml \
           ${RUSTFLAGS:-}" \
  cargo build --release -p approach-viz-runtime 2>&1

if [[ ! -f "$REMARKS_FILE" ]]; then
  echo "ERROR: Remarks file not generated at $REMARKS_FILE" >&2
  exit 1
fi

# Parse manifest and check each expectation
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
    if grep -q "Function:.*${func}" "$REMARKS_FILE" 2>/dev/null; then
      found_width=$(grep -A5 "Function:.*${func}" "$REMARKS_FILE" \
        | grep -oP 'Width:\s*\K[0-9]+' | head -1 || echo "0")
      if [[ "${found_width:-0}" -ge "$width" ]]; then
        echo "  PASS: ${func} (width=${found_width} >= ${width})"
        pass=$((pass + 1))
      else
        echo "  FAIL: ${func} — vectorized but width ${found_width:-unknown} < required ${width}"
        echo "        ${desc}"
        fail=$((fail + 1))
      fi
    else
      echo "  FAIL: ${func} — NOT FOUND in vectorization remarks"
      echo "        ${desc}"
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
