#!/bin/bash
set -e

echo "📥 Downloading FAA CIFP data..."

# Data goes in public/ so Vite serves it statically
DATA_DIR="public/data"
CIFP_DIR="$DATA_DIR/cifp"
AIRSPACE_DIR="$DATA_DIR/airspace"

mkdir -p "$CIFP_DIR" "$AIRSPACE_DIR"

# Download CIFP data (ARINC 424 format) - FAA uses dated zip archives
# Scrape current CIFP URL from FAA download page
CIFP_PAGE="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"
echo "Finding current CIFP URL..."
CIFP_ZIP_URL=$(curl -fsSL "$CIFP_PAGE" | grep -oP 'https://aeronav\.faa\.gov/Upload_313-d/cifp/CIFP_\d+\.zip' | head -1)

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

echo "🎉 All data downloaded successfully!"
