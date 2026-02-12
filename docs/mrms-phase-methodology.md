# MRMS Phase Methodology

This document defines how the Rust MRMS service resolves voxel phase (`rain`, `mixed`, `snow`) from dual-pol inputs.

## Goal

- Keep reflectivity rendering phase-aware without mixing different product cycles.
- Use altitude-aware dual-pol fields instead of surface-only or model-derived proxies.

## Inputs and Alignment

- Reflectivity source: `MergedReflectivityQC_<level>`
- Dual-pol phase sources:
  - `MergedZdr_<level>`
  - `MergedRhoHV_<level>`
- For each voxel slice, all three products use the same:
  - MRMS timestamp (`YYYYMMDD-HHMMSS`)
  - altitude level tag (`00.50..19.00`)
- No lookback probing is allowed for phase auxiliaries, so phase and precip intensity stay on the same cycle family.

## Per-Voxel Classification

The server computes phase from the sampled dual-pol values for each reflectivity voxel.

1. Validate aux ranges:
   - ZDR must be finite and in `[-8.0, 8.0] dB`
   - RhoHV must be finite and in `[0.0, 1.05]`
2. Mixed-phase gate:
   - If `RhoHV < 0.97`, classify as `mixed`
3. Otherwise use ZDR split:
   - If `ZDR >= 0.3 dB`, classify as `rain`
   - If `ZDR <= 0.1 dB`, classify as `snow`
   - Else classify as `mixed`
4. Missing/invalid aux fallback:
   - Classify as `rain`

## Why This Shape

- Low RhoHV is a robust indicator of hydrometeor heterogeneity, so it is prioritized for mixed-phase detection.
- ZDR is then used to separate mostly liquid vs mostly frozen signatures when correlation is high.
- The fallback to rain keeps rendering stable when dual-pol slices are temporarily unavailable.

## Operational Notes

- Grid mismatch protection: if ZDR/RhoHV grid metadata does not match reflectivity for a level, that aux field is ignored for that level (warning logged).
- Phase affects color palette only; reflectivity intensity/opacity behavior is still driven by dBZ.
- Thresholds are defined in `services/mrms-rs/src/constants.rs` and can be tuned with side-by-side visual validation.

