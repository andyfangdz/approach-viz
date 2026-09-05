# Rendering Storm Cells (ProbSevere)

Discrete convective storm-cell objects render as an optional weather overlay.

## Overview

- Storm cells are an independent layer (`ProbSevere` / `probsevere`) and can be shown with or without MRMS volume/echo-top layers.
- Layer default is on.
- Source product is NOAA MRMS ProbSevere object JSON (`ProbSevere 3.0` feature collection).

## Data Path

- Client requests `app/api/weather/nexrad/prob-severe/route.ts` with `lat/lon/maxRangeNm`.
- The route resolves the latest `MRMS_PROBSEVERE_*.json` from the MRMS index page, fetches it, and normalizes polygon/object properties.
- Route filtering keeps only cells whose polygon-derived centroid falls inside the request range.
- All in-range features are returned even when top-height metrics are missing.

## Scene Rendering

- Each in-range cell renders a base polygon outline at ground reference.
- Cells with an available top-height metric also render a top polygon outline, sparse vertical edges, and a top-height label (`kft`).
- Movement-direction vectors use polygon-derived centroids as the arrow anchor and render at top+offset when top is available, otherwise at ground+offset.

## Height and Motion Mapping

- Cell top height prefers ProbSevere `REF20` (kft), falls back to `REF10` (kft), then falls back to `EchoTop_50` (km), and is converted to feet before local-NM altitude mapping.
- Cells without any top-height metric still render (base footprint + vector), but no top cap/label is shown.
- Motion direction uses ProbSevere `MOTION_EAST` + `MOTION_SOUTH` vector components.
- Vector origin uses polygon-derived centroids for all cells.
- Arrow orientation follows the normalized motion vector; arrow length is intentionally scaled with a larger minimum/maximum range to preserve legibility at scene scale.

## Coordinate Frame and Curvature

- Polygon vertices and centroids convert from `lat/lon` into the same local-NM frame used by approach geometry and MRMS volume.
- In satellite/3D-plate modes, top heights apply the same Earth-curvature compensation used by other overlays so storm-cell tops stay co-registered with curved surfaces.

## Polling and Failure Behavior

- Poll cadence: ~120 seconds.
- Retry cadence after transient failures: 15 seconds.
- On transient upstream errors, the overlay preserves the previous successful payload to avoid flicker/disappear behavior.

The ProbSevere proxy uses one 8-second deadline across index discovery, the selected file fetch, and both response-body reads. Failures retain the existing error payload consumed by the overlay.
