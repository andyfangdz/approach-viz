#!/bin/bash
set -e

echo "📥 Downloading FAA CIFP data..."

# Data goes in public/ so Vite serves it statically
DATA_DIR="public/data"
CIFP_DIR="$DATA_DIR/cifp"
AIRSPACE_DIR="$DATA_DIR/airspace"

mkdir -p "$CIFP_DIR" "$AIRSPACE_DIR"

# Download CIFP data (ARINC 424 format)
CIFP_URL="https://aeronav.faa.gov/Upload_313-d/cifp/FAACIFP18"
echo "Fetching CIFP from $CIFP_URL..."
curl -fsSL "$CIFP_URL" -o "$CIFP_DIR/FAACIFP18"
echo "✅ CIFP data downloaded ($(wc -c < "$CIFP_DIR/FAACIFP18" | tr -d ' ') bytes)"

# Download airspace boundaries (GeoJSON)
AIRSPACE_URL="https://opendata.arcgis.com/api/v3/datasets/c6a62360338e408cb1512366ad61559e_0/downloads/data?format=geojson&spatialRefId=4326"
echo "Fetching airspace from FAA..."
curl -fsSL "$AIRSPACE_URL" -o "$AIRSPACE_DIR/airspace_boundary.geojson"
echo "✅ Airspace data downloaded ($(wc -c < "$AIRSPACE_DIR/airspace_boundary.geojson" | tr -d ' ') bytes)"

echo "🎉 All data downloaded successfully!"
