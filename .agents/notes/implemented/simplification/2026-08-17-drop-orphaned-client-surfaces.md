# Agent Note: Drop orphaned client and binding surfaces

Status: implemented

## Problem

After the approach-path engine and MRMS prepare/join moved into `crates/approach-viz-core`, several TypeScript, WASM, and UniFFI leftovers still compiled and looked load-bearing:

- Geometry constants in `app/scene/approach-path/constants.ts` duplicated the Rust engine with zero TypeScript consumers.
- `keepVoxelForDeclutter` and AVMR v4 / cross-section bin constants in `app/scene/nexrad/` survived the Rust prepare-pass move.
- `filterOptions` in `app/app-client-utils.ts` and `TrafficWorkerApi.ingestBinary` had no production callers (the picker uses the filter worker; traffic ingest uses `ingestRuntime`).
- WASM exported `wasm_lat_lon_to_local` / `wasm_alt_to_y` / curvature/radius/projection helpers, and UniFFI exported `lat_lon_to_local` / curvature/radius/projection records, while web uses `app/scene/approach-path/coordinates.ts` and native uses `alt_to_y` + `scene_point_from_geodetic`.
- Four scene files copied `latLonToLocal` instead of importing the shared module.
- README / URL / wire docs still described FloatingPanel, an airport sidebar, plate-as-surface-mode, thermo-as-default phase, and AVMR v3/v4.

## Decision

Delete the unused constants, helpers, worker method, and coordinate binding exports. Fold web `latLonToLocal` onto `app/scene/approach-path/coordinates.ts`. Share AVTR history collection in `traffic_merge::collect_fb_history` instead of twin copies in `wasm.rs` / `ios.rs`. Point direct MRMS binary URLs at `/v1/weather/*` (runtime legacy aliases and the Next.js 404 fallback remain). Align living docs and the live-runtime smoke script with AVMR v5 FlatBuffers.

## Alternatives considered

**Delete the owned FlatBuffers decode path in the same change.** `decode_mrms_fb` / `decode_echo_top_fb` / `decode_traffic_fb` still have no production callers, but tests build `DecodedMrmsVolume` by hand. Folding that surface needs a dedicated fixture rewrite; it is tracked separately.

**Rewrite approach scene composition into Rust now.** Web `ApproachPath.tsx` and iOS `ApproachPathGeometry.swift` still duplicate FAF-append / MAP-extension. That is real duplication, but it is load-bearing geometry and needs plate-visual-check coverage, not a drive-by delete.

**Leave README/plans untouched.** Agents still treated the RealityKit superpowers plan as current (`REQUIRED: execute this plan`). Doc drift was cheaper to fix than another mistaken native rewrite.

## Consequences

WASM/UniFFI coordinate glue is smaller; web projection has one owner. Direct `NEXT_PUBLIC_MRMS_BINARY_BASE_URL` clients now hit the canonical weather-prefixed routes — deployments that only mounted `/v1/volume` would need the still-supported runtime aliases or the Next proxy. Generated WASM JS is rebuilt with this change so the dropped exports do not linger in `packages/approach-viz-core-wasm/`.
