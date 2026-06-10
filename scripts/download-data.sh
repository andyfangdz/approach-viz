#!/bin/bash
set -euo pipefail

echo "📥 Downloading FAA data..."

# Data goes in public/ so Next.js serves it statically
DATA_DIR="public/data"
CIFP_DIR="$DATA_DIR/cifp"
AIRSPACE_DIR="$DATA_DIR/airspace"
APPROACH_DB_DIR="$DATA_DIR/approach-db"

mkdir -p "$CIFP_DIR" "$AIRSPACE_DIR" "$APPROACH_DB_DIR"

# ── Step 1: Download approach-db (source of truth for cycle) ─────────────────
echo "Fetching FAA instrument approach database release..."
APPROACH_DB_RELEASE_API="https://api.github.com/repos/andyfangdz/faa-instrument-approach-db/releases/latest"
RELEASE_JSON="$(curl -fsSL "$APPROACH_DB_RELEASE_API")"

# Release tag = CIFP cycle (from CIFP zip filename the scraper used)
CIFP_CYCLE="$(echo "$RELEASE_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", chunk => (raw += chunk));
  process.stdin.on("end", () => {
    process.stdout.write(JSON.parse(raw).tag_name || "");
  });
')"

APPROACH_DB_URL="$(echo "$RELEASE_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", chunk => (raw += chunk));
  process.stdin.on("end", () => {
    const parsed = JSON.parse(raw);
    const asset = (parsed.assets || []).find(item => item.name === "approaches.json");
    if (asset && asset.browser_download_url) {
      process.stdout.write(asset.browser_download_url);
    }
  });
')"

if [ -z "$APPROACH_DB_URL" ]; then
  echo "❌ Could not find approaches.json release URL"
  exit 1
fi

if [ -z "$CIFP_CYCLE" ]; then
  echo "❌ Could not determine CIFP cycle from release tag"
  exit 1
fi

echo "Fetching approach DB from $APPROACH_DB_URL..."
curl -fsSL "$APPROACH_DB_URL" -o "$APPROACH_DB_DIR/approaches.json"

# dtpp_cycle_number inside the JSON is the d-TPP cycle (can differ from CIFP cycle)
DTPP_CYCLE="$(node -e '
  const path = require("path");
  const d = require(path.resolve("'"$APPROACH_DB_DIR/approaches.json"'"));
  process.stdout.write(d.dtpp_cycle_number || "");
')"

echo "✅ Approach DB downloaded ($(wc -c < "$APPROACH_DB_DIR/approaches.json" | tr -d ' ') bytes)"
echo "📌 CIFP cycle: $CIFP_CYCLE, d-TPP cycle: $DTPP_CYCLE"

# ── Step 2: Download the matching CIFP ───────────────────────────────────────
CIFP_ZIP_URL="https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_${CIFP_CYCLE}.zip"
echo "Fetching CIFP from $CIFP_ZIP_URL..."
if ! curl -fsSL "$CIFP_ZIP_URL" -o "/tmp/cifp.zip"; then
  echo "❌ Failed to download CIFP_${CIFP_CYCLE}.zip — cycle may no longer be available on FAA servers"
  exit 1
fi
unzip -o -j "/tmp/cifp.zip" "FAACIFP18" -d "$CIFP_DIR"
rm "/tmp/cifp.zip"
echo "$CIFP_CYCLE" > "$CIFP_DIR/cycle.txt"
echo "✅ CIFP data downloaded ($(wc -c < "$CIFP_DIR/FAACIFP18" | tr -d ' ') bytes, cycle $CIFP_CYCLE)"

# ── Step 3: Download airspace overlays ───────────────────────────────────────
# Pinned to a specific commit so upstream force-pushes/deletions cannot
# silently change or break the airspace data.
AIRSPACE_DATA_COMMIT="064ed5102e29c008235361436dd42a2ff8a73000"
AIRSPACE_BASE_URL="https://raw.githubusercontent.com/drnic/faa-airspace-data/$AIRSPACE_DATA_COMMIT"

download_airspace() {
  local class_name="$1"
  local source_file="$2"
  local target_file="$3"
  echo "Fetching Class $class_name airspace..."
  curl -fsSL "$AIRSPACE_BASE_URL/$source_file" -o "$target_file.tmp"
  # Validate the payload is parseable GeoJSON before moving it into place.
  node -e '
    const fs = require("fs");
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(parsed.features)) {
      throw new Error("GeoJSON payload has no features array");
    }
  ' "$target_file.tmp" || {
    echo "❌ Class $class_name airspace payload failed GeoJSON validation"
    rm -f "$target_file.tmp"
    exit 1
  }
  mv "$target_file.tmp" "$target_file"
  echo "✅ Class $class_name airspace downloaded ($(wc -c < "$target_file" | tr -d ' ') bytes)"
}

download_airspace "B" "class_b.geo.json" "$AIRSPACE_DIR/class_b.geojson"
download_airspace "C" "class_c.geo.json" "$AIRSPACE_DIR/class_c.geojson"
download_airspace "D" "class_d.geo.json" "$AIRSPACE_DIR/class_d.geojson"

echo "🎉 All data downloaded successfully (CIFP: $CIFP_CYCLE, d-TPP: $DTPP_CYCLE)"
