#!/bin/bash
set -euo pipefail

echo "📥 Downloading FAA CIFP data..."

# Data goes in public/ so Next.js serves it statically
DATA_DIR="public/data"
CIFP_DIR="$DATA_DIR/cifp"
AIRSPACE_DIR="$DATA_DIR/airspace"
APPROACH_DB_DIR="$DATA_DIR/approach-db"

mkdir -p "$CIFP_DIR" "$AIRSPACE_DIR" "$APPROACH_DB_DIR"

# Download CIFP data (ARINC 424 format) - FAA uses dated zip archives
# Scrape current CIFP URL from FAA download page
CIFP_PAGE="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"
echo "Finding current CIFP URL..."
PAGE_HTML="$(curl -fsSL "$CIFP_PAGE")"
CIFP_URL_CANDIDATES="$(
  printf '%s\n' "$PAGE_HTML" \
    | grep -Eo 'https://aeronav\.faa\.gov/Upload_313-d/cifp/CIFP_[0-9]+\.zip' \
    | sort -u \
    || true
)"
CIFP_ZIP_URL="$(printf '%s\n' "$CIFP_URL_CANDIDATES" | sort | tail -1)"

if [ -z "$CIFP_ZIP_URL" ]; then
  echo "❌ Could not find CIFP download URL"
  exit 1
fi

echo "Fetching CIFP from $CIFP_ZIP_URL..."
curl -fsSL "$CIFP_ZIP_URL" -o "/tmp/cifp.zip"
unzip -o -j "/tmp/cifp.zip" "FAACIFP18" -d "$CIFP_DIR"
rm "/tmp/cifp.zip"
echo "✅ CIFP data downloaded ($(wc -c < "$CIFP_DIR/FAACIFP18" | tr -d ' ') bytes)"

# Download US Class B/C/D airspace (from drnic/faa-airspace-data)
# This source has proper altitude bands for approach visualization
echo "Fetching Class B airspace..."
curl -fsSL "https://raw.githubusercontent.com/drnic/faa-airspace-data/master/class_b.geo.json" -o "$AIRSPACE_DIR/class_b.geojson"
echo "✅ Class B airspace downloaded ($(wc -c < "$AIRSPACE_DIR/class_b.geojson" | tr -d ' ') bytes)"

echo "Fetching Class C airspace..."
curl -fsSL "https://raw.githubusercontent.com/drnic/faa-airspace-data/master/class_c.geo.json" -o "$AIRSPACE_DIR/class_c.geojson"
echo "✅ Class C airspace downloaded ($(wc -c < "$AIRSPACE_DIR/class_c.geojson" | tr -d ' ') bytes)"

echo "Fetching Class D airspace..."
curl -fsSL "https://raw.githubusercontent.com/drnic/faa-airspace-data/master/class_d.geo.json" -o "$AIRSPACE_DIR/class_d.geojson"
echo "✅ Class D airspace downloaded ($(wc -c < "$AIRSPACE_DIR/class_d.geojson" | tr -d ' ') bytes)"

# Download instrument approach minimums from andyfangdz/faa-instrument-approach-db
# (fork of ammaraskar/faa-instrument-approach-db with automated AIRAC-cycle releases)
echo "Fetching FAA instrument approach database release..."
APPROACH_DB_RELEASE_API="https://api.github.com/repos/andyfangdz/faa-instrument-approach-db/releases/latest"
APPROACH_DB_URL="$(
  curl -fsSL "$APPROACH_DB_RELEASE_API" \
    | node -e '
      let raw = "";
      process.stdin.on("data", chunk => (raw += chunk));
      process.stdin.on("end", () => {
        const parsed = JSON.parse(raw);
        const asset = (parsed.assets || []).find(item => item.name === "approaches.json");
        if (asset && asset.browser_download_url) {
          process.stdout.write(asset.browser_download_url);
        }
      });
    '
)"

if [ -z "$APPROACH_DB_URL" ]; then
  echo "❌ Could not find approaches.json release URL"
  exit 1
fi

echo "Fetching approach DB from $APPROACH_DB_URL..."
curl -fsSL "$APPROACH_DB_URL" -o "$APPROACH_DB_DIR/approaches.json"
echo "✅ Approach DB downloaded ($(wc -c < "$APPROACH_DB_DIR/approaches.json" | tr -d ' ') bytes)"

# Validate AIRAC cycle consistency between CIFP and approach-db
echo "Validating AIRAC cycle consistency..."
CIFP_CYCLE="$(basename "$CIFP_ZIP_URL" | sed 's/CIFP_//;s/\.zip//')"
APPROACH_DB_CYCLE="$(node -e '
  const path = require("path");
  const d = require(path.resolve("'"$APPROACH_DB_DIR/approaches.json"'"));
  process.stdout.write(d.dtpp_cycle_number || "unknown");
')"

if [ "$CIFP_CYCLE" != "$APPROACH_DB_CYCLE" ]; then
  echo "⚠️  AIRAC cycle mismatch! CIFP=$CIFP_CYCLE, approach-db=$APPROACH_DB_CYCLE"
  echo "   Plate references and minimums may be out of sync."
else
  echo "✅ AIRAC cycles match: $CIFP_CYCLE"
fi

echo "🎉 All data downloaded successfully!"
