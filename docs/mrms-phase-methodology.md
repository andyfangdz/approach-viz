# MRMS Phase Methodology

This document defines how the Rust MRMS service resolves voxel phase (`rain`, `mixed`, `snow`) using dual-pol plus legacy fallback signals.

## Goal

- Keep reflectivity rendering phase-aware even when dual-pol products lag reflectivity publication.
- Prefer dual-pol when timely, but avoid freezing the pipeline waiting for perfect cycle alignment.

## Inputs

- Reflectivity: `MergedReflectivityQC_<level>`
- Dual-pol:
  - `MergedZdr_<level>`
  - `MergedRhoHV_<level>`
- Legacy fallback:
  - `PrecipFlag_00.00`
  - `Model_0degC_Height_00.50`

## Source Selection Policy

1. Preferred dual-pol cycle:
   - Try `MergedZdr_<level>` / `MergedRhoHV_<level>` at the exact reflectivity timestamp.
2. Sparse/lagging dual-pol fallback:
   - If exact dual-pol is missing, use the latest available dual-pol timestamp at or before reflectivity time.
   - If selected dual-pol age exceeds `300s` (5 minutes), mark the scan as stale-aux mode.
3. Legacy fallback activation:
   - When dual-pol is stale, missing, or level-incompatible, enable legacy fallback using latest available `PrecipFlag_00.00` and `Model_0degC_Height_00.50` at or before reflectivity time.

## Per-Voxel Classification

1. Try dual-pol phase first:
   - Validate ZDR in `[-8.0, 8.0] dB`
   - Validate RhoHV in `[0.0, 1.05]`
   - If `RhoHV < 0.97` => `mixed`
   - Else if `ZDR >= 0.3` => `rain`
   - Else if `ZDR <= 0.1` => `snow`
   - Else => `mixed`
2. If dual-pol is unavailable/invalid for that voxel:
   - Use `PrecipFlag_00.00` mapping first.
   - If precip flag is unavailable, compare voxel altitude vs `Model_0degC_Height_00.50` (+/-1500 ft transition band) for rain/mixed/snow.
3. Final fallback:
   - `rain`

## Debug Telemetry

The service emits phase-source metadata so the client debug panel can show:

- phase mode (`dual-pol-cycle-matched`, `dual-pol-last-available`, `dual-pol-last-available+legacy-fallback`)
- dual-pol ages (`zdrAgeSeconds`, `rhohvAgeSeconds`)
- dual-pol timestamps (`zdrTimestamp`, `rhohvTimestamp`)
- legacy timestamps (`precipFlagTimestamp`, `freezingLevelTimestamp`)
- detailed coverage summary (`phaseDetail`)

These fields are exposed via `/v1/meta` and mirrored as response headers on `/v1/volume`.
