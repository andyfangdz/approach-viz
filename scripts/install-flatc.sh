#!/usr/bin/env bash
# Download a pinned version of the FlatBuffers compiler (flatc) to tools/flatc.
# The version MUST match the flatbuffers Rust crate version in Cargo.toml.
set -euo pipefail

FLATC_VERSION="25.12.19"
TOOLS_DIR="$(cd "$(dirname "$0")/.." && pwd)/tools"
FLATC_BIN="$TOOLS_DIR/flatc"

if [[ -x "$FLATC_BIN" ]]; then
  installed=$("$FLATC_BIN" --version | sed 's/flatc version //')
  if [[ "$installed" == "$FLATC_VERSION" ]]; then
    echo "flatc $FLATC_VERSION already installed at $FLATC_BIN"
    exit 0
  fi
  echo "flatc version mismatch: installed=$installed, expected=$FLATC_VERSION"
fi

mkdir -p "$TOOLS_DIR"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  asset="Mac.flatc.binary.zip" ;;
  Darwin-x86_64) asset="MacIntel.flatc.binary.zip" ;;
  Linux-x86_64)  asset="Linux.flatc.binary.clang++-18.zip" ;;
  Linux-aarch64) asset="Linux.flatc.binary.clang++-18.zip" ;;
  *)
    echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

url="https://github.com/google/flatbuffers/releases/download/v${FLATC_VERSION}/${asset}"
echo "Downloading flatc $FLATC_VERSION from $url"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL -o "$tmpdir/flatc.zip" "$url"
unzip -o -q "$tmpdir/flatc.zip" -d "$tmpdir"
mv "$tmpdir/flatc" "$FLATC_BIN"
chmod +x "$FLATC_BIN"

echo "Installed flatc $("$FLATC_BIN" --version) at $FLATC_BIN"
