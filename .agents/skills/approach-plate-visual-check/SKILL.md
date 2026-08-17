---
name: approach-plate-visual-check
description: Visually verify approach-viz's computed approach-path geometry against the official FAA approach plate. Fetches and renders the real d-TPP plate, dumps the shared engine's top-down geometry for real CIFP procedures with one command, and overlays the geometry directly on the georeferenced plate. Use when changing approach-path rendering (procedure turns, teardrops/course-reversals, DME arcs, RF legs, holds, missed segments) or when a procedure "looks wrong" versus the chart.
---

# Approach Plate Visual Check

## Overview

Rendering bugs in approach geometry are hard to judge from code or numbers — they
are obvious the moment you put the computed path on top of the chart. This skill
makes that comparison repeatable:

1. Fetch and render the official FAA plate (d-TPP) for an airport + approach.
2. Dump the **shared Rust engine's** computed geometry for real CIFP procedures
   as top-down "segments files" (so what you inspect is exactly what ships to
   web and iOS) — one command, no hand-edited test code.
3. **Overlay** the computed geometry directly on the plate using the plate's
   embedded georeference (GPTS/LPTS viewport control points — the same data the
   app's `ApproachPlateSurface` uses). That shows whether a computed turn/arc
   actually lies on the chart's drawn line and exactly where it diverges.

Key caveats: **FAA plan views are schematic where space is tight** (holds are
often drawn compressed), and the bilinear control-point map has a little slack
(~1-2 NM over a full US plate). Judge a maneuver's shape, side, and placement
against the chart line, not sub-NM pixels. `plot_geometry.py` remains available
for a north-up side-by-side when a plate is unavailable.

## Inputs

- `repo_root`: repository path (run everything from the repo root).
- Airport ICAO id (e.g., `KDDC`) and the CIFP procedure id (e.g., `I14`,
  `S24`, `H19-Z`) — list an airport's procedures with the dump script.
- A chart-name substring for the plate (e.g., `"ILS OR LOC RWY 14"`).
- `public/data/cifp/FAACIFP18` must exist (`npm run download-data`).

## Quick Start

```bash
SKILL=.agents/skills/approach-plate-visual-check

# 0. Discover procedures for an airport (ids, leg types, transitions).
bash "$SKILL/scripts/dump_geometry.sh" KDDC

# 1. Dump the shared engine's geometry for real CIFP procedures. This extracts
#    the procedures with lib/cifp/parser, composes segments the way the scene
#    does, appends a temporary test to approach_path/tests.rs, runs it, and
#    restores tests.rs automatically.
bash "$SKILL/scripts/dump_geometry.sh" KDDC:I14 KACK:S24
#   -> .tmp/plate-visual-check/geometry/plate_geometry_<key>.txt
#   -> .tmp/plate-visual-check/geometry/procedures.json  (ref lat/lon, leg
#      summaries, and a ready-to-run overlay command per procedure)

# 2. Fetch + render the plate (auto-discovers the newest published cycle; pin
#    with --cycle YYMM if needed).
bash "$SKILL/scripts/fetch_plate.sh" KDDC "ILS OR LOC RWY 14"
#   -> View the printed *_full.png to read the plan view.

# 3. Overlay the computed geometry on the georeferenced plate. ref-lat/ref-lon
#    come from procedures.json (the airport = the engine's projection
#    reference); --zoom-fix centers on a fix of interest.
python3 "$SKILL/scripts/overlay_geometry.py" \
  .tmp/plate-visual-check/KDDC/00676IL14.pdf \
  .tmp/plate-visual-check/geometry/plate_geometry_kddc_i14.txt \
  --ref-lat 37.7631 --ref-lon -99.9654 --zoom-fix WEROM --pad 230 \
  --out .tmp/plate-visual-check/geometry/kddc_i14_overlay.png
#   -> View the overlay: computed path drawn on top of the chart. Iterate on
#      the engine (crates/approach-viz-core/src/approach_path/) and re-dump.
```

## Workflow

1. **Pick procedures.** `dump_geometry.sh <ICAO>` lists an airport's CIFP
   procedures with per-leg path terminators — useful for finding a procedure
   that stresses the leg type under test (`PI`, `FC`+`CI`, `AF`, `RF`, `HF`…).
2. **Dump geometry.** `dump_geometry.sh <ICAO>:<PROC_ID> ...` produces one
   segments file per procedure from the real CIFP data, through the same
   `resolve_approach_altitudes` + `compose_approach_scene` + `build_path_geometry` + `build_hold_geometry`
   calls the web (WASM) and iOS (UniFFI) clients make, with the shared
   composition export (final extended through the first missed fix; the final's first
   course-carrying leg appended to `CI`/`VI`/`AF`/`RF`-terminated transitions;
   holds dumped separately).
3. **Fetch the plate.** `fetch_plate.sh <ICAO> "<chart name>"` resolves the
   plate PDF from the d-TPP metafile, downloads it, and renders a PNG. With an
   empty chart name it lists every chart for the airport.
4. **Overlay + judge.** `overlay_geometry.py` draws the segments file on the
   georeferenced plate. Segment colors follow the app (final green, transitions
   orange, missed red, holds blue). Compare each maneuver's shape, side, and
   anchor fix against the chart's line; re-dump after engine changes.
5. **No cleanup needed** for the standard flow: `dump_geometry.sh` restores
   `tests.rs` itself (even on failure), and everything else lives under
   `.tmp/plate-visual-check/` (already format/lint-ignored).

## Segments-file format

```
FIX <name> <x> <z>
SEG <label> <x0>,<z0> <x1>,<z1> ...
```

Coordinates are the engine's local scene NM from `coords::lat_lon_to_local`
(x = east, z = -north), with the airport as the reference. `plot_geometry.py`
displays north-up (north = -z), matching the north-up plate plan view. The
`<label>` prefix before `:` drives the line color (`final`/`localizer`,
`transition`, `missed`, `hold`); suffixes name the transition or hold fix.

## Bundled Resources

- `scripts/dump_geometry.sh` — one-command geometry dump for real CIFP
  procedures (extract → temporary test → run → restore), plus procedure listing.
- `scripts/extract_geometry.ts` — CIFP extraction + Rust test generation
  (used by `dump_geometry.sh`; calls `compose_approach_scene`).
- `scripts/fetch_plate.sh` — resolve + download + render an FAA d-TPP plate.
- `scripts/find_plate.py` — look up a plate PDF name in the d-TPP metafile.
- `scripts/render_plate.py` — render a PDF page/region to PNG (PyMuPDF).
- `scripts/overlay_geometry.py` — overlay a segments file on the georeferenced
  plate (GPTS/LPTS control points) for a precise on-chart comparison.
- `scripts/plot_geometry.py` — plot a segments file north-up, optionally beside
  the plate render (schematic side-by-side fallback).
- `templates/dump_geometry.rs.txt` — manual diagnostic-test template; only
  needed for synthetic/hypothetical leg data that is not in the CIFP (for real
  procedures use `dump_geometry.sh`). Delete the temp test before committing.

## Notes

- Python deps (`pymupdf`, `matplotlib`, `pillow`, plus `numpy` for
  `overlay_geometry.py`) are auto-installed on demand; `extract_geometry.ts`
  runs via `npx tsx` (repo dev dependency).
- Network access to `aeronav.faa.gov` is required to fetch the metafile/plate.
  Cycle auto-discovery probes newest-first and skips FAA-pre-created future
  cycle directories whose metafile is not published yet; `--cycle YYMM` pins a
  specific AIRAC cycle. The metafile is cached per cycle under the output
  directory.
- In restricted environments where `npm run download-data` cannot reach the
  GitHub release for `approaches.json`, the CIFP itself can be fetched directly:
  the zips are listed at `https://aeronav.faa.gov/Upload_313-d/cifp/` (named by
  full effective date, e.g. `CIFP_260611.zip`); extract `FAACIFP18` to
  `public/data/cifp/`. Only the CIFP is needed for geometry dumps.
