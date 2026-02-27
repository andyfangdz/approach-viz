# SIMD Phase 2: Explicit Intrinsics + SoA Wire Formats

## Goal

SIMD-accelerate the two performance-critical runtime scoring functions and all
four WASM binary decoders using the `wide` crate for portable SIMD, and migrate
wire formats to SoA (struct-of-arrays) layout to eliminate decode overhead.

Phase 1 showed that LLVM cannot auto-vectorize either runtime function:
`filter_voxels_by_threshold` uses a conditional-push pattern that LLVM rejects,
and `compute_phase_scores_branchless` has a complex function body with multiple
output arrays. Explicit SIMD via `wide` solves both.

## Architecture

Two workstreams that share the `wide` dependency:

1. **Runtime SIMD** (aarch64 NEON) — vectorize filter and phase scoring using
   `wide::f32x4` / `wide::i16x8` on the existing SoA data from the multi-pass
   pipeline.

2. **SoA wire format + WASM decode** — change wire format from AoS (packed
   records) to SoA (contiguous per-field arrays), then decode in WASM with
   zero-copy slice reinterpretation + `wide` for any remaining arithmetic.

Both workstreams also include a Rust edition 2024 upgrade.

## Decisions

| Decision            | Choice                      | Rationale                                                                        |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| SIMD abstraction    | `wide` v1.1.1               | Stable Rust, zero transitive deps, aarch64 + wasm32                              |
| Filter compress     | LUT (256-entry, 8-bit mask) | Avoids branch mispredictions at 30% pass rate                                    |
| Phase scoring       | Full f32x4 vectorization    | All stages branchless via compare + blend                                        |
| Wire format         | Custom SoA                  | Zero-copy decode, we control both ends, minimal overhead                         |
| Backwards compat    | None                        | Clean version bump, coordinated deploy                                           |
| Edition             | 2024                        | Stricter `unsafe_op_in_unsafe_fn` scoping                                        |
| Arrow / FlatBuffers | Rejected                    | Schemas are fixed + simple; dependency weight and WASM bundle size not justified |

## Dependencies

- `wide = "1.1.1"` — both `runtime-rs` and `approach-viz-core`
- `bytemuck = "1"` with `derive` feature — `approach-viz-core` (safe slice reinterpretation)
- No nightly toolchain required

## Workstream 1: Runtime SIMD

### filter_voxels_by_threshold — i16x8 + LUT Compress

Current: scalar loop comparing `&[i16]` values, pushing matching indices to
`Vec<u32>`. ~30ms for 3.5M elements.

SIMD approach:

1. Load 8 x i16 per iteration as `i16x8`.
2. Compare `>= threshold` to produce an 8-bit mask.
3. Look up mask in a precomputed 256-entry LUT that maps each bitmask to packed
   lane offsets and a count.
4. Write `count` matching indices to the output Vec using the LUT offsets added
   to the current base index.
5. Scalar tail loop for final `n % 8` elements.

LUT structure: `static LUT: [([u8; 8], u8); 256]` generated at compile time
with `const fn`. Each entry stores the positions of set bits (0-7) and the
popcount. ~2KB total.

Target: 5-10ms (3-6x improvement).

### compute_phase_scores_branchless — Full f32x4 Vectorization

Current: scalar loop calling `score_single_voxel` per element. ~300ms for ~1M
voxels (full pipeline including dual-pol and mixed promotion).

SIMD approach: replace `score_single_voxel` with `score_4_voxels` operating on
`f32x4` throughout. Every stage becomes vectorized:

**Precip flag scoring** — equality comparisons against known codes (1, 3, 6, 7,
10, 91, 96) produce masks; predicated adds accumulate scores.

**Freezing level scoring** — already branchless `fmask * value` arithmetic maps
directly to f32x4 multiply + add.

**Wet bulb / surface temp / bright band** — range comparisons (`cmp_le`,
`cmp_ge`) produce masks; `blend` selects score contributions. Replaces if-else
trees.

**Dual-pol evidence** — ZDR/RhoHV validity checks + threshold comparisons
produce phase and confidence as f32x4. Nested conditions become chained
compare + select.

**Ranking** — 3-value sort via min/max on f32x4. Mixed promotion and margin
checks become predicated arithmetic.

**Output** — intermediate f32x4 signal counts and phase codes convert to u8 at
the end. Scalar tail loop for final `n % 4` elements.

All `Option<f32>` logic replaced by NaN-sentinel masks (`is_finite()`). All
`match`/`if-else` trees replaced by compare + blend chains.

Target: 75-100ms (3-4x improvement).

## Workstream 2: SoA Wire Formats + WASM Decode

### Wire Format Design

Each protocol bumps its version. After a fixed 64-byte header, fields are stored
as contiguous arrays in a defined order. No padding between arrays.

#### AVMR v4 (MRMS Volume)

```
Header (64 bytes, version=4)
  i16[n]  x_hundredths
  i16[n]  z_hundredths
  u16[n]  bottom_feet
  u16[n]  top_feet
  i16[n]  dbz_tenths
  u8[n]   phase_code
  u8[n]   surface_phase_code
  u16[n]  footprint_x_span
  u16[n]  footprint_y_span
```

Total: 64 + 14n bytes (vs 64 + 20n for v3 — smaller because SoA eliminates
per-record padding).

#### AVET v2 (Echo Tops)

```
Header (64 bytes, version=2)
  f32[n]  x_nm
  f32[n]  z_nm
  u16[n]  top18_feet
  u16[n]  top30_feet
  u16[n]  top50_feet
  u16[n]  top60_feet
```

Total: 64 + 16n bytes (same size as v1, different layout).

#### AVTR v2 (Traffic)

```
Header (64 bytes, version=2)

Aircraft section:
  u32[a]  hex_str_offset
  u16[a]  hex_str_length
  u32[a]  flight_str_offset
  u16[a]  flight_str_length
  u16[a]  flags
  f32[a]  lat
  f32[a]  lon
  f32[a]  altitude_feet
  f32[a]  ground_speed_kt
  f32[a]  track_deg
  f32[a]  last_seen_seconds

History group section:
  u32[g]  hex_str_offset
  u16[g]  hex_str_length
  u32[g]  point_start
  u32[g]  point_count

History point section:
  f32[p]  lat
  f32[p]  lon
  f32[p]  altitude_feet
  i64[p]  timestamp_ms

String table (unchanged)
```

### WASM Decode Strategy

With SoA layout, most decoding becomes zero-copy slice reinterpretation via
`bytemuck::cast_slice`. Both wasm32 and aarch64 are little-endian, so no
byte-swapping is needed.

| Decoder          | SIMD Work                           | Non-SIMD Work       |
| ---------------- | ----------------------------------- | ------------------- |
| Echo-Top         | None (zero-copy)                    | Header validation   |
| MRMS Voxel       | i16 -> f32 scaling (x, z coords)    | Header validation   |
| Traffic History  | None (zero-copy)                    | Header validation   |
| Traffic Aircraft | f32 NaN detection (optional fields) | String table lookup |

The MRMS i16-to-f32 conversion processes 8 values per iteration: `i16x8` widen
to 2 x `i32x4`, convert to `f32x4`, divide by `f32x4::splat(100.0)`.

The footprint `max(1, value)` operation vectorizes as
`u16x8::max(values, u16x8::splat(1))`.

### Encoder Changes (Runtime)

The runtime currently packs AoS records in encoder functions. These change to
write contiguous arrays. The runtime already has SoA data internally (from the
multi-pass pipeline for MRMS, and from separate fields for traffic/echo-tops),
so encoding SoA is simpler than the current AoS packing.

## Edition 2024 Upgrade

Both crates (`runtime-rs` and `approach-viz-core`) upgrade from edition 2021 to 2024. The main effect is `unsafe_op_in_unsafe_fn` becoming `deny` by default,
which enforces explicit `unsafe {}` blocks inside `unsafe fn` bodies. Low risk:
neither crate currently has `unsafe fn` definitions.

## Expected Performance

| Component                       | Current   | Target          | Mechanism                |
| ------------------------------- | --------- | --------------- | ------------------------ |
| filter_voxels_by_threshold      | 30ms      | 5-10ms          | i16x8 + LUT compress     |
| compute_phase_scores_branchless | 300ms     | 75-100ms        | Full f32x4 vectorization |
| Echo-top decode (WASM)          | O(n) loop | O(1) cast       | SoA zero-copy            |
| MRMS voxel decode (WASM)        | O(n) loop | O(n/8) SIMD     | SoA + vectorized scaling |
| Traffic history decode (WASM)   | O(n) loop | O(1) cast       | SoA zero-copy            |
| Traffic aircraft decode (WASM)  | O(n) loop | ~O(1) + strings | SoA zero-copy            |

## Testing Strategy

- **Equivalence tests**: SIMD output must match scalar output exactly. Existing
  15,000-voxel randomized tests run against the SIMD path.
- **Wire format round-trip tests**: encode SoA on runtime, decode in core,
  compare against known values.
- **Criterion benchmarks**: extend existing filter + phase scoring benchmarks
  with SIMD variants. Add WASM decode benchmarks.
- **CI vectorization manifest**: update with `[[expect]]` entries for functions
  that use `wide` (if LLVM remarks show vectorization of the `wide` calls).
- **Integration tests**: `npm run test:integration:runtime` validates end-to-end
  after wire format change.

## Task Ordering

1. Edition 2024 upgrade (both crates)
2. Add `wide` + `bytemuck` dependencies
3. Filter LUT compress with `wide` (runtime)
4. Phase scoring full f32x4 vectorization (runtime)
5. SoA wire format encoders (runtime: AVMR v4, AVET v2, AVTR v2)
6. SoA wire format decoders (core: AVMR v4, AVET v2, AVTR v2)
7. WASM decode SIMD for MRMS i16-to-f32 scaling
8. Update benchmarks, CI manifest, integration tests
9. Coordinated deploy (runtime + WASM client together)
