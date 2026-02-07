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

# Download airspace boundaries (GeoJSON)
AIRSPACE_URL="https://opendata.arcgis.com/api/v3/datasets/c6a62360338e408cb1512366ad61559e_0/downloads/data?format=geojson&spatialRefId=4326"
echo "Fetching airspace from FAA..."
curl -fsSL "$AIRSPACE_URL" -o "$AIRSPACE_DIR/airspace_boundary.geojson"
echo "✅ Airspace data downloaded ($(wc -c < "$AIRSPACE_DIR/airspace_boundary.geojson" | tr -d ' ') bytes)"

echo "🎉 All data downloaded successfully!"
