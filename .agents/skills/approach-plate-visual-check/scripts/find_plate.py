#!/usr/bin/env python3
"""Find a plate PDF name in an FAA d-TPP metafile.

Reads the airport id from $APT and a case-insensitive chart_name substring from
$CHART. Prints the matching <pdf_name>. With an empty $CHART, lists every
IAP chart for the airport (name -> pdf) to stderr to help pick a substring.

Usage: APT=DDC CHART="ILS OR LOC RWY 14" find_plate.py <metafile.xml>
"""
import os
import sys
import xml.etree.ElementTree as ET


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: find_plate.py <metafile.xml>", file=sys.stderr)
        return 2
    apt = os.environ.get("APT", "").strip().upper()
    chart = os.environ.get("CHART", "").strip().upper()
    if not apt:
        print("APT env var is required", file=sys.stderr)
        return 2

    tree = ET.parse(sys.argv[1])
    root = tree.getroot()

    matches = []
    listing = []
    for airport in root.iter("airport_name"):
        if (airport.get("apt_ident", "").upper() != apt
                and airport.get("icao_ident", "").upper() != apt):
            continue
        for record in airport.iter("record"):
            if (record.findtext("chart_code") or "").strip() != "IAP":
                continue
            name = (record.findtext("chart_name") or "").strip()
            pdf = (record.findtext("pdf_name") or "").strip()
            listing.append((name, pdf))
            if chart and chart in name.upper():
                matches.append((name, pdf))

    if not chart:
        for name, pdf in listing:
            print(f"  {name}  ->  {pdf}", file=sys.stderr)
        return 0

    if not matches:
        return 0
    # Prefer an exact (case-insensitive) name match, else the shortest name.
    matches.sort(key=lambda m: (m[0].upper() != chart, len(m[0])))
    print(matches[0][1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
