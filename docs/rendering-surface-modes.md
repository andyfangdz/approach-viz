# Rendering Surface Modes

## Supported Modes

- `Terrain`: Terrarium-based wireframe terrain grid sampled over a default `50 NM` radius around the selected airport reference.
- `FAA Plate`: geolocated FAA approach plate mesh replacing terrain at selected approach.
- `3D Plate`: FAA plate texture projected onto Google Photorealistic 3D Tiles terrain using the same `3d-tiles-renderer` pipeline as Satellite mode.
- `Satellite`: Google Earth Photorealistic 3D Tiles rendered via `3d-tiles-renderer`, transformed into the app's local frame using `@takram/three-geospatial`.

## Surface-Independent Overlays

- MRMS 3D volumetric weather is an overlay (not a surface mode) and can be enabled alongside any surface mode.
- MRMS overlay volume is assembled from multi-radar merged reflectivity slices (`00.50..19.00 km`) and rendered as a stacked 3D precipitation field.
- In terrain/plate modes the weather voxels render directly in the local NM frame; in satellite/3D plate modes voxel altitude applies curvature compensation so weather remains co-registered with curved tiled terrain.
- MRMS voxel coloring is phase-aware (rain/mixed/snow): server-side phase codes prefer level-matched MRMS dual-pol fields (`MergedZdr`, `MergedRhoHV`) at the reflectivity timestamp (low RhoHV -> mixed, otherwise ZDR separates rain vs snow), then apply legacy correction when dual-pol resolves `mixed` and a precip-flag snow bias (`PrecipFlag_00.00` snow can override dual-pol rain/mixed); when dual-pol lags/sparsity exceeds 5 minutes, phase falls back to latest available aux plus legacy PrecipFlag/freezing-level logic.
- MRMS color gain is applied with channel-safe scaling (hue-preserving boost without RGB clipping) so distant/high-altitude bins stay cyan/blue instead of bleaching toward white.
- MRMS voxels render in two passes: a primary alpha pass (`transparent=true`, `NormalBlending`, `FrontSide`, `depthWrite=true`) for stable density control plus a lighter additive glow pass (`AdditiveBlending`, `FrontSide`) for radar-style bloom.
- MRMS voxels render without scene fog contribution so echoes keep their intended color/intensity.
- MRMS overlay opacity is user-configurable in the options panel so voxel intensity can be tuned per-surface and time-of-day visibility needs.
- MRMS opacity slider updates mutate both voxel-pass opacities in place (no voxel remount/rebuild), so adjusting transparency does not drop the rendered volume.
- MRMS voxel dimensions are derived from decoded MRMS grid spacing (independent X/Y footprint) and per-level altitude bounds, using the same local projection scales as voxel center placement so rendered cell size matches source data resolution without row-dependent drift.

## Shared Vertical-Scale Behavior

- Terrain wireframe elevation samples are fetched/decoded per-airport reference and reused across vertical-scale changes; vertical exaggeration updates apply via Y-scale transform (no tile refetch/rebuild on slider changes).
- Terrain mode radius is user-adjustable from the options panel (`20..80 NM`, step `5`, default `50`) and terrain tiles/geometry are rebuilt when the radius changes.
- FAA plate surface texture/geometry is fetched and rasterized per selected plate/airport reference; vertical-scale changes apply via mesh Y-scale transform (no plate re-fetch/re-render on slider changes).
- 3D plate texture projection data is fetched/rasterized per selected plate/airport reference; vertical-scale changes reuse the shared 3D-tile transform (no plate re-fetch/re-render on slider changes).
- FAA plate PDF rasterization uses 4x render scale (retina-quality) for both flat FAA Plate surface rendering and 3D Plate texture projection.

## FAA Plate Specifics

- FAA plate mesh is rendered at the selected airport elevation (scaled by vertical scale), not fixed at sea-level.
- FAA plate mode falls back to terrain when no matching plate metadata is found for the selected approach.

## Satellite and 3D Plate Specifics

- Satellite mode loads Google tiles directly on the client (no server-side imagery proxy).
- Satellite and 3D plate modes require `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and do not provide a runtime key-entry fallback UI.
- Satellite mode retries renderer initialization up to 3 times on runtime failures; after retries are exhausted, show an in-app error message and keep current surface mode (no automatic terrain fallback).
- Satellite mode terrain is vertically aligned to the app's MSL altitude frame by offsetting tiles to the selected airport elevation.
- Satellite mode applies EGM96 geoid separation per airport when converting MSL airport elevation to WGS84 ellipsoid height for the tile anchor transform.
- Satellite and 3D plate modes support a `Flatten Bathymetry` option (gear/options panel, enabled by default) that clamps Google 3D Tiles bathymetry using curvature-compensated, vertical-scale-neutral local altitude (`worldY / verticalScale + curvatureDrop`) so true negative-elevation seabed is flattened without over-flattening distant above-sea terrain.
- In satellite mode, airport/runway context markers apply WGS84 curvature-drop compensation from the selected-airport tangent origin so nearby runways stay grounded.
- Satellite mode uses a tighter tile error target (`~12`) to keep nearby airport surfaces readable.
- Satellite/3D plate tile renderers are keyed by airport (not selected approach) so switching procedures does not remount the tileset or churn tile sessions.
- 3D plate mode applies georeferenced plate texturing directly to Google 3D Tiles terrain materials (shader projection in local scene coordinates).
- 3D plate mode does not fall back to Terrarium wireframe terrain; it keeps the Google 3D Tiles surface active and omits only the plate texture overlay when no plate metadata is available.
