# MRMS Phase Methodology

This document defines the server-side voxel phase resolver (`rain`, `mixed`, `snow`) used by the Rust MRMS pipeline.

## Phase Detection Modes

Two phase detection modes are supported. Both are pre-computed at ingest time and stored per-voxel; the client selects which to use for rendering.

- **Thermodynamic** (default): Per-voxel per-altitude resolution using the full scoring pipeline described below.
- **Surface Precip Type**: Uses the MRMS `PrecipFlag_00.00` surface product to assign a single phase to the entire vertical column at each grid cell. When PrecipFlag is missing or unavailable (codes -3, 0, or absent), falls back to rain. This mode matches the single-precip-type presentation used by official NWS radar products and avoids the "surprise snow" effect in tall CB towers.

The remainder of this document describes the thermodynamic resolver.

## Goals

- Keep phase classification stable when MRMS dual-pol cadence lags reflectivity cadence.
- Reduce false `mixed` speckle in snow regimes (for example Northeast winter stratiform events).
- Keep fallback behavior explicit in runtime debug telemetry.

## Inputs

- Reflectivity backbone: `MergedReflectivityQC_<level>`
- Dual-pol per-level correction signals:
  - `MergedZdr_<level>`
  - `MergedRhoHV_<level>`
- Thermodynamic/context signals:
  - `PrecipFlag_00.00`
  - `Model_0degC_Height_00.50`
  - `Model_WetBulbTemp_00.50`
  - `Model_SurfaceTemp_00.50`
  - `BrightBandTopHeight_00.00`
  - `BrightBandBottomHeight_00.00`
  - `RadarQualityIndex_00.00`

## Timestamp Selection

1. Dual-pol first tries exact reflectivity timestamp matching.
2. If exact dual-pol is unavailable, ingest uses the latest available dual-pol timestamp at or before reflectivity time.
3. If selected dual-pol is older than 5 minutes (`300s`) or sparse by level, ingest enters aux-fallback mode (`aux_fallback=yes` in debug detail).
4. Thermodynamic/context fields always use the latest available timestamp at or before reflectivity time.

## Per-Voxel Resolver

1. Build thermodynamic baseline scores (`rain`, `mixed`, `snow`) from:
   - `PrecipFlag` regime (snow/rain/hail-like mixed classes)
   - voxel altitude relative to `Model_0degC_Height`
   - wet-bulb and surface-temperature tendencies (temperature normalization handles Celsius/Kelvin payload conventions)
   - bright-band top/bottom placement relative to voxel altitude
2. Build dual-pol evidence with confidence, not hard phase assignment:
   - high-confidence rain/snow only when ZDR/RhoHV combination is coherent
   - low RhoHV alone is treated as low-confidence mixed evidence
3. Fuse dual-pol evidence into thermo scores with staleness/quality weighting:
   - stale/sparse aux mode strongly down-weights dual-pol contribution
   - `RadarQualityIndex` scales correction weight when available
4. Apply mixed-suppression guardrails:
   - when rain/snow scores are both strong and close, resolver adds a bounded mixed-transition promotion so boundaries render as a transition band instead of a hard rain/snow seam
   - mixed is still suppressed when it has weak score separation outside transition-like contexts
5. Apply local boundary blending:
   - for voxels marked as transition candidates, if immediate neighbors contain the opposite rain/snow phase, voxel phase is promoted to mixed to prevent hard rain/snow seams in contiguous precip bands
6. Apply snow guardrail:
   - when `PrecipFlag` indicates snow and thermo context supports frozen precipitation, final phase is forced to snow over contradictory weak dual-pol rain/mixed signals.

## PrecipFlag Mapping

- `3` -> snow
- `1, 6, 10, 91, 96` -> rain
- `7` -> mixed/hail-like
- `0, -3` -> no direct phase signal (not forced to rain)

## Debug Telemetry

`/v1/meta` and `/v1/weather/volume` headers expose (legacy weather alias `/v1/volume` is identical):

- `phaseMode`: one of
  - `thermo-primary`
  - `thermo-primary+dual-correction`
  - `thermo-primary+stale-dual-correction`
  - `thermo-primary+aux-fallback`
- dual-pol ages/timestamps (`zdr*`, `rhohv*`)
- aux precip/freezing timestamps (`precipFlagTimestamp`, `freezingLevelTimestamp`)
- `phaseDetail` counters including:
  - aux availability flags (`aux_wetbulb`, `aux_surface_temp`, `aux_brightband_pair`, `aux_rqi`)
  - fallback state (`aux_fallback`, `aux_any`)
  - voxel accounting (`thermo_signal_voxels`, `dual_adjusted_voxels`, `dual_suppressed_voxels`, `mixed_suppressed_voxels`, `mixed_edge_promoted_voxels`, `precip_snow_forced_voxels`)
