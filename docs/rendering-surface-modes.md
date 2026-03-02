# Rendering Surface Modes

## Supported Modes

- `Terrain`: Terrarium-based wireframe terrain grid sampled over a default `50 NM` radius around the selected airport reference.
- `Satellite`: Google Earth Photorealistic 3D Tiles rendered via `3d-tiles-renderer`, transformed into the app's local frame using `@takram/three-geospatial`.
- `Map`: Flat textured plane with FAA aeronautical chart tiles (VFR Sectional, IFR Low Enroute, or IFR High Enroute) from public FAA ArcGIS tile services.
- `3D Map`: FAA chart tiles displayed alongside Google Photorealistic 3D Tiles terrain using the same `3d-tiles-renderer` pipeline as Satellite mode.

## FAA Plate Overlay

FAA approach plates are an independent overlay toggle (not a surface mode) available on all four surface modes. When enabled:

- On flat modes (Terrain, Map): plate mesh rendered above the base surface.
- On tiled modes (Satellite, 3D Map): plate texture projected onto Google 3D Tiles via shader patching.
- Only visible when an approach with plate metadata is selected.
- Legacy URLs `?surface=plate` and `?surface=3dplate` are automatically migrated to `?surface=terrain&plate=on` and `?surface=satellite&plate=on`.

## Weather Overlay

MRMS 3D volumetric weather is a surface-independent overlay (not a surface mode). Full details in [`docs/rendering-weather-volume.md`](rendering-weather-volume.md).

## Shared Vertical-Scale Behavior

- Terrain wireframe elevation samples are fetched/decoded per-airport reference and reused across vertical-scale changes; vertical exaggeration updates apply via Y-scale transform (no tile refetch/rebuild on slider changes).
- Terrain mode radius is user-adjustable from the options panel (`20..80 NM`, step `5`, default `50`) and terrain tiles/geometry are rebuilt when the radius changes.
- FAA plate surface texture/geometry is fetched and rasterized per selected plate/airport reference; vertical-scale changes apply via mesh Y-scale transform (no plate re-fetch/re-render on slider changes).
- 3D plate texture projection data is fetched/rasterized per selected plate/airport reference; vertical-scale changes reuse the shared 3D-tile transform (no plate re-fetch/re-render on slider changes).
- FAA plate PDF rasterization uses 4x render scale (retina-quality) for both flat FAA Plate surface rendering and 3D Plate texture projection.
- A client-registered service worker caches FAA plate PDFs, Terrarium elevation tiles, and FAA chart tiles; plate caches are cycle-scoped and old D-TPP cycle caches are purged when the active cycle changes.

## FAA Chart Map Specifics

- Chart type picker (VFR / IFR Low / IFR High) is shown when Map or 3D Map mode is active; default is VFR.
- Tile sources (public FAA ArcGIS, no API key): VFR Sectional (zoom 8–12), IFR Low Enroute (zoom 7–12), IFR High Enroute (zoom 5–9).
- Zoom level is selected automatically based on terrain radius setting and chart type zoom range.
- Chart tiles are fetched in parallel, composited onto a canvas, and rendered as a textured plane at airport elevation.
- URL state: `?chart=vfr|low|high` (omitted when VFR or not in map mode).

## FAA Plate Overlay Specifics

- FAA plate mesh is rendered at the selected airport elevation (scaled by vertical scale), not fixed at sea-level.
- When plate overlay is enabled but no matching plate metadata is found, a warning is shown in the legend panel.
- URL state: `?plate=on` (omitted when off).

## Satellite and 3D Plate Specifics

- Satellite mode loads Google tiles directly on the client (no server-side imagery proxy).
- Satellite and 3D plate modes require `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and do not provide a runtime key-entry fallback UI.
- Satellite mode retries renderer initialization up to 3 times on runtime failures; after retries are exhausted, show an in-app error message and keep current surface mode (no automatic terrain fallback).
- Satellite mode terrain is vertically aligned to the app's MSL altitude frame by offsetting tiles to the selected airport elevation.
- Satellite mode applies EGM96 geoid separation per airport when converting MSL airport elevation to WGS84 ellipsoid height for the tile anchor transform.
- Satellite and 3D plate modes support a `Flatten Bathymetry` option (gear/options panel, enabled by default) that clamps Google 3D Tiles bathymetry using curvature-compensated, vertical-scale-neutral local altitude (`worldY / verticalScale + curvatureDrop`) so true negative-elevation seabed is flattened without over-flattening distant above-sea terrain.
- In satellite mode, airport/runway context markers apply WGS84 curvature-drop compensation from the selected-airport tangent origin so nearby runways stay grounded.
- Satellite mode keeps a tight tile error target (`~12`) for traversal detail.
- Satellite/3D plate tile renderers are keyed by airport (not selected approach) so switching procedures does not remount the tileset or churn tile sessions.
- Plate overlay on tiled modes applies georeferenced plate texturing directly to Google 3D Tiles terrain materials (shader projection in local scene coordinates).
- 3D Map mode does not fall back to Terrarium wireframe terrain; it keeps the Google 3D Tiles surface active and omits only the plate texture overlay when no plate metadata is available.
