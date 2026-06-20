---
name: approach-plate-visual-check
description: Visually verify approach-viz's computed approach-path geometry against the official FAA approach plate. Fetches and renders the real d-TPP plate, dumps the shared engine's top-down geometry, and plots them for side-by-side comparison. Use when changing approach-path rendering (teardrops/course-reversals, DME arcs, holds, missed segments) or when a procedure "looks wrong" versus the chart.
---

# Approach Plate Visual Check

## Overview

Rendering bugs in approach geometry are hard to judge from code or numbers — they
are obvious the moment you put the computed path next to the chart. This skill
makes that comparison repeatable:

1. Fetch and render the official FAA plate (d-TPP) for an airport + approach.
2. Dump the **shared Rust engine's** computed geometry for that procedure as a
   top-down "segments file" (so what you inspect is exactly what ships to web
   and iOS).
3. Plot the geometry north-up and compare it to the plate's plan view.

Key caveat: **FAA plan views are schematic, not to scale.** Match topology and
shape (which fix the curve starts at, which way it bulges, where it rejoins the
course), not pixel positions. A pixel overlay will not line up.

## Inputs

- `repo_root`: repository path (run from this directory).
- Airport ICAO id (e.g., `KDDC`) and a chart-name substring (e.g.,
  `"ILS OR LOC RWY 14"`).
- Real procedure data: the CIFP rows (`FAACIFP18`) and fix lat/lons for the
  legs you want to inspect (see `docs/data-sources.md`). Use real data so the
  dump matches production.

## Quick Start

```bash
SKILL=.agents/skills/approach-plate-visual-check

# 1. Fetch + render the plate. First call renders the full page so you can read
#    the plan-view coordinates; re-run with --clip "<x0 y0 x1 y1>" (PDF points)
#    to get a tight plan-view crop.
bash "$SKILL/scripts/fetch_plate.sh" KDDC "ILS OR LOC RWY 14"
bash "$SKILL/scripts/fetch_plate.sh" KDDC "ILS OR LOC RWY 14" --clip "40 95 320 300"
#   -> View the *_full.png / *_plan.png that are printed.

# 2. Dump computed geometry: copy templates/dump_geometry.rs.txt into
#    crates/approach-viz-core/src/approach_path/tests.rs, edit legs/waypoints
#    from the real CIFP rows, then:
cargo test -p approach-viz-core dump_plate_geometry
#   -> writes /tmp/plate_geometry.txt   (DELETE the temp test before committing)

# 3. Plot side-by-side with the plate plan view:
python3 "$SKILL/scripts/plot_geometry.py" /tmp/plate_geometry.txt /tmp/compare.png \
  --plate .tmp/plate-visual-check/KDDC/00676IL14_plan.png --xlim -11 2 --ylim 3 22
#   -> View /tmp/compare.png and iterate on the geometry.
```

## Workflow

1. **Identify the chart.** `fetch_plate.sh <ICAO> "<chart name>"` resolves the
   plate PDF from the d-TPP metafile, downloads it, and renders a PNG. With an
   empty chart name you can list every IAP for the airport:
   `APT=DDC CHART='' python3 "$SKILL/scripts/find_plate.py" <metafile.xml>`.
2. **Crop the plan view.** Read the full-page render, note the PDF-point box
   around the plan view, and re-run with `--clip "x0 y0 x1 y1"` (US plates are
   ~387x594 pt; the plan view is the upper-middle band).
3. **Dump geometry.** Use `templates/dump_geometry.rs.txt`. Build legs from the
   real CIFP rows and real fix lat/lons, with the airport as the projection
   reference and the airport's `mag_var`. Write one `SEG` per procedure piece
   (final, each transition, missed, hold). The dump uses the same
   `build_path_geometry` the web (WASM) and iOS (UniFFI) clients call.
4. **Plot + compare.** `plot_geometry.py` draws the geometry north-up next to
   the plate. Compare topology/shape, then adjust the engine
   (`crates/approach-viz-core/src/approach_path/`) and re-dump.
5. **Clean up.** Delete the temporary dump test before committing. The plate
   PNGs and `/tmp` artifacts are scratch.

## Segments-file format

```
FIX <name> <x> <z>
SEG <label> <x0>,<z0> <x1>,<z1> ...
```

Coordinates are the engine's local scene NM from `coords::lat_lon_to_local`
(x = east, z = -north), with the airport as the reference. `plot_geometry.py`
displays north-up (north = -z), matching the north-up plate plan view. `<label>`
drives the line color (`final`/`localizer`, `transition`, `missed`, `hold` are
special-cased).

## Bundled Resources

- `scripts/fetch_plate.sh` — resolve + download + render an FAA d-TPP plate.
- `scripts/find_plate.py` — look up a plate PDF name in the d-TPP metafile.
- `scripts/render_plate.py` — render a PDF page/region to PNG (PyMuPDF).
- `scripts/plot_geometry.py` — plot a segments file, optionally beside the plate.
- `templates/dump_geometry.rs.txt` — diagnostic test template for the geometry dump.

## Notes

- Python deps (`pymupdf`, `matplotlib`, `pillow`) are auto-installed on demand.
- Network access to `aeronav.faa.gov` is required to fetch the metafile/plate.
- The metafile is cached per cycle under the output directory; `--cycle YYMM`
  pins a specific AIRAC cycle (default: latest).
