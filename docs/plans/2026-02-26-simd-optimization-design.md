# SIMD Optimization Design

## Goal

Improve throughput of computational hotspots in both the Rust runtime service
(aarch64 NEON) and the WASM core library (wasm32 simd128) through
auto-vectorization restructuring first, then targeted intrinsics where
auto-vectorization cannot reach.

## Strategy

1. **Auto-vectorization first** — restructure hot loops so LLVM can vectorize
   them without any platform-specific code.
2. **Targeted intrinsics second** — for patterns LLVM cannot handle (AoS→SoA
   stride decoding), use `core::arch::wasm32` / `core::arch::aarch64` behind
   `cfg` gates.
3. **Prove it** — LLVM vectorization remarks (YAML), assembly inspection, and
   criterion benchmarks must all confirm vectorization before any claim of
   improvement.

## Hotspot Analysis

### Runtime (services/runtime-rs/)

| Hotspot | File | Loop scale | Primary blocker |
|---------|------|-----------|-----------------|
| Voxel grid processing | `weather/processor.rs:332-413` | 20-60M iter/scan | Data-dependent `continue`; Option chains; 8+ branches in phase scoring |
| Volume wire voxel filter | `weather/encoding.rs:220-266` | 50-200K voxels/query | 4 branch conditions; Vec push; quantization branch |
| Echo-top cell filter | `weather/encoding.rs:87-118` | 1-50K cells/query | 3 branch conditions; Vec push |
| Thermo phase scoring | `weather/phase.rs:163-305` | 20-60M calls/scan | Deep Option nesting; f64/f32 mixing; conditional score accumulation |

### WASM Core (crates/approach-viz-core/)

| Hotspot | File | Loop scale | Primary blocker |
|---------|------|-----------|-----------------|
| MRMS voxel decode | `mrms_wire_codec.rs:146-186` | 10-200K records | 8 Vec::push per iter; 20-byte stride gather |
| Echo-top cell decode | `echo_top_wire_codec.rs:138-154` | 1-50K records | 6 Vec::push per iter; 16-byte stride |
| Volume preprocessing | `mrms_preprocess.rs:83-129` | 10-200K voxels | 3 early exits; f32→f64→f32 round-trip; function call in loop |
| Batch lat_lon_to_local | `coords.rs:55-74` | 1-50K calls/frame | Scalar function; 6-level FP dependency chain |

## Auto-Vectorization Blockers (Common Patterns)

1. **Data-dependent `continue`** — LLVM cannot vectorize when loop trip count
   varies per iteration. Fix: split into filter pass (produce valid indices)
   then compute pass (iterate valid indices only).
2. **Option chains in hot loops** — `and_then().copied()` compiles to branches.
   Fix: pre-gather aux values into flat arrays, use NaN as sentinel.
3. **Type mixing** — f32↔f64 conversions halve SIMD width. Fix: demote to f32
   where precision is sufficient (phase scoring weights, altitude deltas).
4. **Vec::push serialization** — capacity check + length increment per push
   serializes iterations. Fix: pre-allocate and write by index.
5. **Function calls in loops** — non-inlined calls break vectorization across
   call boundaries. Fix: `#[inline(always)]` or hoist loop-invariant calls.

## Design: processor.rs Multi-Pass Restructure

The monolithic voxel loop (lines 332-413) processes each cell through filter →
sample → compute → tally → pack with branches at every step. Restructure into
four passes:

### Pass 1 — Filter (vectorizable: 8×i16 NEON)

```
Input:  dbz_tenths[nx*ny]  (contiguous i16 slice)
Output: valid_indices: Vec<u32>
Op:     dbz_tenths[i] >= STORE_MIN_DBZ_TENTHS
```

Simple threshold scan over a contiguous i16 array. LLVM vectorizes the
comparison (8 i16 lanes per NEON register) and uses compress-store for indices.

### Pass 2 — Gather Aux Fields (not vectorizable, memory-bound)

```
Input:  valid_indices, 7 AuxFieldSamplers, 2 level-direct arrays
Output: 9 flat f32 arrays (NaN for missing), length = valid_count
```

AuxFieldSampler indirection (row_map/col_map lookup) is inherently scalar.
Separating it removes Option chains from the compute pass. This pass is
memory-bound, not compute-bound.

### Pass 3 — Phase Scoring (vectorizable: 4×f32 NEON)

```
Input:  9 flat f32 arrays, voxel_mid_feet (loop-invariant)
Output: phase_code[n], surface_phase[n], transition_candidate[n]
```

Rewrite `resolve_thermo_phase` as branchless predicated f32 arithmetic:

```rust
// Instead of:
if let Some(freezing) = freezing_value {
    let delta = voxel_mid_feet - freezing * FEET_PER_METER;
    if delta >= 2500.0 { scores.add(PHASE_SNOW, 2.4) }
}

// Use:
let has_freezing = freezing[i].is_finite();       // NaN → false
let delta = voxel_mid_feet_f32 - freezing[i] * FEET_PER_METER_F32;
let mask = has_freezing as u32 as f32;            // 0.0 or 1.0
let cold_mask = (delta >= 2500.0) as u32 as f32;
snow_score += 2.4 * mask * cold_mask;
```

No branches. All f32. NaN propagation handles missing values naturally
(NaN comparisons return false → mask = 0.0 → zero contribution).

**f64 → f32 demotion:** Phase scoring uses f64 only because aux values pass
through f64 intermediaries. The source data is f32 (GRIB), and scoring weights
are small constants. f32 precision is sufficient (altitude deltas of hundreds
of feet, not millimeters). This doubles throughput: 4×f32 vs 2×f64 per NEON
register.

### Pass 4 — Tally + Pack (scalar, low volume)

```
Input:  phase results, valid_indices
Output: Vec<LevelPhaseVoxel>, diagnostic counters
```

Iterates ~30% of grid (valid voxels only). Counter tallying and struct packing
are scalar but cheap relative to the compute pass.

### Validation

A test runs both the old and new paths on a synthetic grid and asserts
bit-identical `phase`, `surface_phase`, and `transition_candidate` for every
voxel.

## Design: encoding.rs Multi-Pass Restructure

### Voxel Filter Loop (lines 220-266)

Split into two passes per tile batch:

**Pass 1 — Filter + Project:** Batch voxels from all tiles into flat buffer.
Pre-compute x_nm, z_nm via table lookup. Compute dist² = x² + z² (vectorizable
f64 mul+add). Produce valid_mask from 4 comparison results ANDed together.

**Pass 2 — Quantize + Pack:** Batch `quantize_dbz_tenths` on flat i16 array
(branchless: abs + round + sign restore, 8×i16 NEON). Bucket by level_idx
(scalar scatter).

### Echo-Top Filter (lines 87-118)

Same filter-then-pack split. Simpler (no quantization, no level bucketing).

### Brick Merging (lines 268-323)

Stays scalar. HashMap-based sequential state machine, processes ~10K merged
rectangles — not a bottleneck.

### Wire Serialization (lines 326-360)

Pre-allocate exact output size, write by offset instead of extend_from_slice.
Eliminates repeated capacity checks.

### Expected Gains

| Component | Change | Expected gain |
|-----------|--------|---------------|
| Voxel filter loop | Multi-pass batch | 1.5-2x |
| Echo-top filter | Multi-pass batch | ~1.5x |
| Brick merging | Unchanged | — |
| Wire serialization | Pre-allocate | 1.1-1.2x |

## Vectorization Verification

Three layers of evidence, all must agree:

### 1. LLVM Vectorization Remarks (YAML)

```
RUSTFLAGS="-C llvm-args=-pass-remarks=loop-vectorize \
           -C llvm-args=-pass-remarks-output=vectorization.yaml \
           -C llvm-args=-pass-remarks-format=yaml" \
  cargo build --release -p approach-viz-runtime
```

Produces structured YAML with function names, vectorization width, and
interleave count per vectorized loop.

### 2. Assembly Inspection

```
cargo asm --bench weather_ingest <function_name> --rust
```

On aarch64: confirm NEON instructions (`ld1`, `fmul v0.4s`, `fcmgt`, `stp q0`).

### 3. Benchmark Delta

Criterion benchmarks must show speedup proportional to vector width
(4×f32 = expect ~2.5-3.5x after overhead).

## CI Vectorization Regression Check

**Manifest** (`services/runtime-rs/vectorization-manifest.toml`):

```toml
# Loops that MUST remain auto-vectorized.
# CI fails if any disappear from LLVM vectorization remarks.

[[expect]]
function = "filter_voxels_by_threshold"
min_width = 8
description = "i16 dbz threshold scan in processor.rs Pass 1"

[[expect]]
function = "compute_phase_scores_branchless"
min_width = 4
description = "f32 predicated phase scoring in processor.rs Pass 3"

[[expect]]
function = "compute_distance_squared_batch"
min_width = 2
description = "f64 dist² in encoding.rs voxel filter"

[[expect]]
function = "quantize_dbz_batch"
min_width = 8
description = "i16 branchless quantization in encoding.rs"
```

**Check script** (`scripts/ci/check-vectorization.sh`):

1. Build with LLVM remarks YAML output.
2. Parse YAML for each `[[expect]]` entry — match function name substring,
   check vectorization width >= min_width.
3. Exit 1 with report if any expected vectorization is missing.

New `[[expect]]` entries are added in the same PR that adds vectorized code.

## Intrinsics Plan (Phase 2)

After auto-vectorization is proven on the runtime, add hand-written intrinsics
for patterns LLVM cannot handle.

### Target: WASM Wire Format Decoders

The AoS→SoA unpacking loops in approach-viz-core decode fixed-stride binary
records (20-byte MRMS, 16-byte echo-top, 40-byte traffic) into separate typed
arrays. LLVM won't vectorize these because the stride patterns don't match
standard vector access.

**Dual codepath with cfg:**

```rust
#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;  // v128 loads + shuffle

#[cfg(target_arch = "aarch64")]
use core::arch::aarch64::*;  // NEON loads + tbl
```

**Priority:**

1. Echo-top decoder — 16-byte records align with v128.
2. MRMS voxel decoder — 20-byte records, 4 records = 5×v128.
3. Traffic history decoder — 20-byte records, same pattern.
4. Traffic aircraft decoder — 40-byte, complex (string refs need scalar).

### Not Planned for Intrinsics

- Runtime encoding paths (auto-vectorization should suffice)
- AuxFieldSampler gather (memory-bound, indirect indexing)
- Brick merging (HashMap-based, too small)
- Rectangle building (loop-carried state)

## Phasing

```
Phase 0 — Benchmarks + CI scaffold
  - Add criterion to runtime
  - Create weather_ingest + weather_encode benchmarks with synthetic data
  - Capture aarch64 baselines
  - Set up CI check script + empty manifest

Phase 1 — processor.rs restructure
  - 4-pass voxel loop
  - Branchless phase scoring
  - Populate vectorization manifest
  - Target: 3-5x on scoring pass, ~2x end-to-end ingest

Phase 2 — encoding.rs restructure
  - Multi-pass voxel filter + batch quantize
  - Pre-allocate wire output
  - Target: 1.5-2x on query path

Phase 3 — WASM intrinsics
  - WASM benchmark harness
  - simd128 wire decoders
  - Target: 2-3x on decode paths

Phase 4 — Runtime intrinsics (if needed)
  - Only if auto-vec benchmarks show gaps
  - Likely: filter compress-store, dist² batch
```

Each phase is independently deployable and measurable.
