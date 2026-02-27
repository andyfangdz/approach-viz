# SIMD Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SIMD-accelerate runtime scoring (filter + phase) with `wide` crate intrinsics, and migrate all wire formats to SoA layout for zero-copy WASM decode.

**Architecture:** Two workstreams sharing the `wide` crate: (1) runtime SIMD on existing SoA data from the multi-pass pipeline, (2) SoA wire format migration across AVMR/AVET/AVTR with coordinated encoder+decoder changes. Edition 2024 upgrade first.

**Tech Stack:** Rust edition 2024, `wide` 1.1.1, `bytemuck` 1.x, Criterion 0.5 benchmarks

**Design doc:** `docs/plans/2026-02-26-simd-phase2-design.md`

---

### Task 1: Upgrade Both Crates to Rust Edition 2024

**Files:**

- Modify: `services/runtime-rs/Cargo.toml:4` — change `edition = "2021"` to `edition = "2024"`
- Modify: `crates/approach-viz-core/Cargo.toml:4` — change `edition = "2021"` to `edition = "2024"`

**Step 1: Change edition in both Cargo.toml files**

In `services/runtime-rs/Cargo.toml`, line 4:

```toml
edition = "2024"
```

In `crates/approach-viz-core/Cargo.toml`, line 4:

```toml
edition = "2024"
```

**Step 2: Check for new warnings/errors**

Run:

```bash
cargo check -p approach-viz-runtime 2>&1
cargo check -p approach-viz-core 2>&1
```

Expected: clean compile (no `unsafe fn` in either crate). If there are warnings about `unsafe_op_in_unsafe_fn`, add inner `unsafe {}` blocks where the compiler indicates.

**Step 3: Run all tests**

Run:

```bash
cargo test --workspace 2>&1
```

Expected: all 106 tests pass (76 core + 30 runtime).

**Step 4: Commit**

```bash
git add services/runtime-rs/Cargo.toml crates/approach-viz-core/Cargo.toml
git commit -m "build: upgrade both crates to Rust edition 2024"
```

---

### Task 2: Add `wide` and `bytemuck` Dependencies

**Files:**

- Modify: `services/runtime-rs/Cargo.toml` — add `wide = "1.1.1"` to `[dependencies]`
- Modify: `crates/approach-viz-core/Cargo.toml` — add `wide = "1.1.1"` and `bytemuck = { version = "1", features = ["derive"] }` to `[dependencies]`

**Step 1: Add dependencies**

In `services/runtime-rs/Cargo.toml`, add to `[dependencies]`:

```toml
wide = "1.1.1"
```

In `crates/approach-viz-core/Cargo.toml`, add to `[dependencies]`:

```toml
wide = "1.1.1"
bytemuck = { version = "1", features = ["derive"] }
```

**Step 2: Verify they compile for all targets**

Run:

```bash
cargo check -p approach-viz-runtime 2>&1
cargo check -p approach-viz-core --target wasm32-unknown-unknown 2>&1
cargo check -p approach-viz-core --target aarch64-apple-darwin 2>&1
```

Expected: all three clean.

**Step 3: Commit**

```bash
git add services/runtime-rs/Cargo.toml crates/approach-viz-core/Cargo.toml
git commit -m "build: add wide and bytemuck dependencies for SIMD"
```

---

### Task 3: Build Filter LUT (Compile-Time Lookup Table)

**Files:**

- Create: `services/runtime-rs/src/weather/simd_lut.rs`
- Modify: `services/runtime-rs/src/weather/mod.rs` — add `mod simd_lut;`

**Context:** The LUT maps each 8-bit comparison mask to a list of set-bit positions and a count. For mask `0b01011010` (bits 1,3,4,6 set), the LUT entry stores `([1,3,4,6,0,0,0,0], 4)`. This is used by the SIMD filter to convert a vector comparison result into indices without branches.

**Step 1: Write the LUT test**

Create `services/runtime-rs/src/weather/simd_lut.rs`:

```rust
/// Compile-time lookup table for SIMD compress operations.
///
/// Maps each 8-bit mask to (positions of set bits, popcount).
/// Used by filter_voxels_by_threshold to convert i16x8 comparison
/// masks into output indices without branches.

/// For mask value `m`, `COMPRESS_LUT[m]` contains:
/// - `.0`: positions of set bits (0-7), padded with 0
/// - `.1`: number of set bits (popcount)
pub(crate) static COMPRESS_LUT: [([u8; 8], u8); 256] = build_compress_lut();

const fn build_compress_lut() -> [([u8; 8], u8); 256] {
    let mut table = [([0u8; 8], 0u8); 256];
    let mut mask: usize = 0;
    while mask < 256 {
        let mut positions = [0u8; 8];
        let mut count: u8 = 0;
        let mut bit: u8 = 0;
        while bit < 8 {
            if (mask >> bit) & 1 == 1 {
                positions[count as usize] = bit;
                count += 1;
            }
            bit += 1;
        }
        table[mask] = (positions, count);
        mask += 1;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_mask_zero_has_no_entries() {
        let (positions, count) = COMPRESS_LUT[0];
        assert_eq!(count, 0);
        assert_eq!(positions, [0; 8]);
    }

    #[test]
    fn lut_mask_all_ones() {
        let (positions, count) = COMPRESS_LUT[0xFF];
        assert_eq!(count, 8);
        assert_eq!(positions, [0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn lut_mask_alternating() {
        // 0b10101010 = 0xAA -> bits 1,3,5,7
        let (positions, count) = COMPRESS_LUT[0xAA];
        assert_eq!(count, 4);
        assert_eq!(positions[..4], [1, 3, 5, 7]);
    }

    #[test]
    fn lut_mask_single_bit() {
        for bit in 0..8u8 {
            let mask = 1usize << bit;
            let (positions, count) = COMPRESS_LUT[mask];
            assert_eq!(count, 1, "mask={mask:#04x}");
            assert_eq!(positions[0], bit, "mask={mask:#04x}");
        }
    }

    #[test]
    fn lut_popcount_matches_u8_count_ones() {
        for mask in 0..256usize {
            let (_, count) = COMPRESS_LUT[mask];
            assert_eq!(
                count,
                (mask as u8).count_ones() as u8,
                "mask={mask:#04x}"
            );
        }
    }
}
```

**Step 2: Register the module**

In `services/runtime-rs/src/weather/mod.rs`, add alongside the other module declarations:

```rust
mod simd_lut;
```

**Step 3: Run tests**

Run:

```bash
cargo test -p approach-viz-runtime simd_lut 2>&1
```

Expected: 5 tests pass.

**Step 4: Commit**

```bash
git add services/runtime-rs/src/weather/simd_lut.rs services/runtime-rs/src/weather/mod.rs
git commit -m "feat(runtime): add compile-time compress LUT for SIMD filter"
```

---

### Task 4: SIMD Filter with LUT Compress

**Files:**

- Modify: `services/runtime-rs/src/weather/processor.rs` — replace `filter_voxels_by_threshold` body
- Test: existing tests + new SIMD-specific tests in `processor.rs`

**Context:** Current `filter_voxels_by_threshold` (processor.rs:36-44) iterates `&[i16]` and pushes matching indices. Replace the inner loop with `wide::i16x8` comparisons + LUT compress, keeping the same function signature.

**Step 1: Write SIMD equivalence test**

Add to the `#[cfg(test)] mod tests` block in `processor.rs` (or create one if absent):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn filter_scalar_reference(data: &[i16], threshold: i16) -> Vec<u32> {
        let mut out = Vec::new();
        for (i, &val) in data.iter().enumerate() {
            if val >= threshold {
                out.push(i as u32);
            }
        }
        out
    }

    #[test]
    fn simd_filter_matches_scalar() {
        // Test with various sizes including non-multiple-of-8
        for n in [0, 1, 7, 8, 9, 15, 16, 100, 1000, 12_250_000] {
            let data: Vec<i16> = (0..n).map(|i| ((i * 7 + 3) % 200 - 50) as i16).collect();
            let threshold = 50i16;
            let expected = filter_scalar_reference(&data, threshold);
            let actual = filter_voxels_by_threshold(&data, threshold);
            assert_eq!(actual, expected, "mismatch at n={n}");
        }
    }

    #[test]
    fn simd_filter_empty_input() {
        assert_eq!(filter_voxels_by_threshold(&[], 50), Vec::<u32>::new());
    }

    #[test]
    fn simd_filter_all_pass() {
        let data = vec![100i16; 17];
        let result = filter_voxels_by_threshold(&data, 50);
        assert_eq!(result.len(), 17);
    }

    #[test]
    fn simd_filter_none_pass() {
        let data = vec![10i16; 17];
        let result = filter_voxels_by_threshold(&data, 50);
        assert!(result.is_empty());
    }
}
```

**Step 2: Run tests to verify they pass with the current scalar implementation**

Run:

```bash
cargo test -p approach-viz-runtime -- tests::simd_filter 2>&1
```

Expected: all 4 tests pass (they test the current scalar code).

**Step 3: Replace filter body with SIMD + LUT implementation**

Replace the body of `filter_voxels_by_threshold` in `processor.rs`:

```rust
use wide::i16x8;
use super::simd_lut::COMPRESS_LUT;

#[inline(never)]
pub(crate) fn filter_voxels_by_threshold(dbz_tenths: &[i16], threshold: i16) -> Vec<u32> {
    let n = dbz_tenths.len();
    let mut out = Vec::with_capacity(n / 3);
    let thresh_v = i16x8::splat(threshold);

    let chunks = n / 8;
    let remainder = n % 8;

    for chunk_idx in 0..chunks {
        let base = chunk_idx * 8;
        let vals = i16x8::from([
            dbz_tenths[base],
            dbz_tenths[base + 1],
            dbz_tenths[base + 2],
            dbz_tenths[base + 3],
            dbz_tenths[base + 4],
            dbz_tenths[base + 5],
            dbz_tenths[base + 6],
            dbz_tenths[base + 7],
        ]);

        // Compare: lanes where val >= threshold get all bits set
        let cmp = vals.cmp_ge(thresh_v);
        let mask = cmp.move_mask() as usize & 0xFF;

        if mask == 0 {
            continue;
        }

        let (positions, count) = COMPRESS_LUT[mask];
        let base_u32 = base as u32;
        for j in 0..count as usize {
            out.push(base_u32 + positions[j] as u32);
        }
    }

    // Scalar tail for remaining elements
    let tail_start = chunks * 8;
    for i in tail_start..n {
        if dbz_tenths[i] >= threshold {
            out.push(i as u32);
        }
    }

    out
}
```

**Important notes for the implementer:**

- `wide::i16x8` comparison methods return an `i16x8` with all-bits-set for true lanes. Check the actual API — the method may be `cmp_ge()` or `simd_ge()`. Consult `wide` docs.
- `move_mask()` extracts one bit per lane into a `u32`. Verify this exists on `i16x8` — if not, convert to `i8x16` or use an alternative approach to extract the bitmask.
- If `wide` doesn't support `move_mask()` on `i16x8`, use `to_array()` and build the mask manually: `let arr = cmp.to_array(); let mask = ((arr[0] != 0) as usize) | ((arr[1] != 0) as usize) << 1 | ...`.

**Step 4: Run tests**

Run:

```bash
cargo test -p approach-viz-runtime -- tests::simd_filter 2>&1
```

Expected: all 4 tests pass.

**Step 5: Run full test suite**

Run:

```bash
cargo test --workspace 2>&1
```

Expected: all tests pass (the function signature is unchanged, so all callers work).

**Step 6: Run benchmark**

Run:

```bash
cargo bench -p approach-viz-runtime -- filter_pass 2>&1
```

Expected: significant improvement over the 30ms baseline. Target: 5-10ms.

**Step 7: Commit**

```bash
git add services/runtime-rs/src/weather/processor.rs
git commit -m "perf(runtime): SIMD filter with i16x8 compare + LUT compress"
```

---

### Task 5: Fully Vectorize Phase Scoring — Core f32x4 Loop

**Files:**

- Modify: `services/runtime-rs/src/weather/phase_batch.rs` — rewrite `compute_phase_scores_branchless` to use `wide::f32x4`

**Context:** The current function calls `score_single_voxel` per element. Replace the main loop with a `score_4_voxels` function that processes 4 elements at a time using `f32x4`. Keep the scalar `score_single_voxel` for the tail loop (last `n % 4` elements) and for equivalence testing.

This is the largest single task. The approach: convert every stage of `score_single_voxel` (lines 121-381) into f32x4 operations.

**Step 1: Understand the scoring stages**

Read `services/runtime-rs/src/weather/phase_batch.rs` in full. The stages are:

1. Precip flag scoring (lines 141-153) — match on discrete codes
2. Freezing level scoring (lines 155-189) — already branchless f32 arithmetic
3. Wet bulb scoring (lines 192-208) — 4-way branch on temperature ranges
4. Surface temp scoring (lines 211-231) — weighted branch on temperature
5. Bright band scoring (lines 234-250) — dual NaN check + range comparison
6. RQI normalization (line 253)
7. Thermo ranking (lines 256-264) — sort 3 values
8. Dual-pol evidence (line 267) — match on zdr/rhohv validity
9. Dual-pol integration (lines 279-304) — weight + conditional add
10. Mixed promotion (lines 307-324) — multi-condition gap calc
11. Final ranking + mixed suppression (lines 327-348)
12. Forced precip-snow override (lines 351-357)
13. Surface phase + transition candidate (lines 360-369)

**Step 2: Write the vectorized implementation**

Add a new function `score_4_voxels` that takes `f32x4` inputs and returns vectorized outputs. The key patterns:

**NaN validity mask:** Replace `value.is_finite()` with:

```rust
use wide::f32x4;
let valid = value.is_finite(); // returns f32x4 with all-bits-set or 0
```

**Predicated score accumulation:** Replace `if valid { score += weight }` with:

```rust
score += valid & f32x4::splat(weight); // bitwise AND: 0.0 if invalid, weight if valid
```

**Discrete code matching:** Replace `match code { 3 => ..., 7 => ... }` with:

```rust
let is_snow = precip.cmp_eq(f32x4::splat(3.0));
let is_mixed = precip.cmp_eq(f32x4::splat(7.0));
let is_rain = precip.cmp_eq(f32x4::splat(1.0))
    | precip.cmp_eq(f32x4::splat(6.0))
    | precip.cmp_eq(f32x4::splat(10.0))
    | precip.cmp_eq(f32x4::splat(91.0))
    | precip.cmp_eq(f32x4::splat(96.0));
snow_score += is_snow & f32x4::splat(3.2);
rain_score += is_rain & f32x4::splat(3.0);
// etc.
```

**Range branching:** Replace `if wb <= -2.0 { ... } else if wb <= 0.5 { ... }` with:

```rust
let strong_cold = wb_valid & wb.cmp_le(f32x4::splat(STRONG_COLD));
let cold = wb_valid & wb.cmp_le(f32x4::splat(0.5)) & !strong_cold;
let strong_warm = wb_valid & wb.cmp_ge(f32x4::splat(STRONG_WARM)) & !strong_cold & !cold;
let warm = wb_valid & !strong_cold & !cold & !strong_warm;
snow_score += (strong_cold & f32x4::splat(2.4)) + (cold & f32x4::splat(1.0));
rain_score += (strong_warm & f32x4::splat(2.2)) + (warm & f32x4::splat(1.0));
mixed_score += (cold | warm) & f32x4::splat(1.1);
```

**3-value ranking:** Replace the sort-3 with:

```rust
// Find max of rain/mixed/snow scores
let rm_max = rain_score.max(mixed_score);
let best = rm_max.max(snow_score);
// Phase code: 0=rain, 1=mixed, 2=snow
// Use comparisons to determine which score is best
let is_best_snow = snow_score.cmp_eq(best) & !mixed_score.cmp_eq(best);
// ... build phase code from masks
```

**Output conversion:** After the f32x4 loop, convert accumulated f32 values to u8/bool and write to output vectors:

```rust
let arr = phase_f32.to_array();
phase_out[base] = arr[0] as u8;
phase_out[base + 1] = arr[1] as u8;
// etc.
```

**Step 3: Rewrite the main loop in `compute_phase_scores_branchless`**

Replace the `for i in 0..n` loop (lines 70-102) with:

```rust
let chunks = n / 4;
let remainder = n % 4;

for chunk_idx in 0..chunks {
    let base = chunk_idx * 4;
    // Load f32x4 from each input slice
    let pf = f32x4::from([precip_flag[base], precip_flag[base+1], precip_flag[base+2], precip_flag[base+3]]);
    let fl = f32x4::from([freezing_level[base], /* ... */]);
    // ... load all 9 input arrays

    // Run vectorized scoring
    let (phase4, surface_phase4, transition4, signal4, used4, suppressed4, smixed4, forced4) =
        score_4_voxels(voxel_mid_feet_v, pf, fl, wb, st, bbt, bbb, rqi_v, zdr_v, rhohv_v, use_aux_fallback);

    // Write to output vectors
    let p = phase4.to_array();
    phase_out[base] = p[0]; phase_out[base+1] = p[1]; phase_out[base+2] = p[2]; phase_out[base+3] = p[3];
    // ... write all 8 outputs
}

// Scalar tail loop
for i in (chunks * 4)..n {
    let (phase, surface_phase, /*...*/) = score_single_voxel(/*...*/);
    phase_out[i] = phase;
    // ...
}
```

**Step 4: Run equivalence tests**

Run:

```bash
cargo test -p approach-viz-runtime phase_batch 2>&1
```

Expected: both `branchless_matches_scalar` (10,000 voxels) and `branchless_matches_scalar_with_aux_fallback` (5,000 voxels) pass with 0 mismatches.

**These tests are critical.** They compare the SIMD output against the scalar pipeline for every field (phase, surface_phase, used_dual, suppressed_dual, suppressed_mixed, forced_precip_snow, signal_count). Any mismatch means the vectorization has a bug.

**Step 5: Run full test suite**

Run:

```bash
cargo test --workspace 2>&1
```

Expected: all tests pass.

**Step 6: Run benchmark**

Run:

```bash
cargo bench -p approach-viz-runtime -- phase_scoring 2>&1
```

Expected: `phase_scoring_branchless` drops from ~300ms to ~75-100ms.

**Step 7: Commit**

```bash
git add services/runtime-rs/src/weather/phase_batch.rs
git commit -m "perf(runtime): fully vectorize phase scoring with f32x4"
```

**Implementation notes for the engineer:**

- The `wide` crate comparison and bitwise methods may have different names than shown. Check `wide` docs — methods might be `cmp_ge`, `simd_ge`, or operator overloads.
- Keep `score_single_voxel` intact — it's used by the scalar tail loop and by equivalence tests.
- The `signal_count` accumulator can be tracked as f32x4 (adding 1.0 per valid signal) and converted to u8 at the end.
- Boolean outputs (used_dual, suppressed_dual, etc.) can be tracked as f32x4 masks and converted to bool at the end via `arr[i] != 0.0`.
- If any stage is too difficult to vectorize (particularly the dual-pol evidence resolution with its nested Option matching), it's acceptable to fall back to scalar for that stage: extract 4 values, process scalar, pack back. The freezing level and precip flag stages (the hottest) should definitely be vectorized.

---

### Task 6: AVET v2 SoA Encoder (Echo-Tops)

**Files:**

- Modify: `services/runtime-rs/src/weather/encoding.rs:123-161` — rewrite `build_echo_top_wire`
- Modify: `services/runtime-rs/src/constants.rs` — update AVET version constant

**Context:** Echo-top is the simplest protocol (6 fields, no merging). The encoder currently writes 16-byte AoS records. Change to SoA: header + contiguous f32[] x_nm + f32[] z_nm + u16[] top18 + u16[] top30 + u16[] top50 + u16[] top60.

**Step 1: Update version constant**

In `services/runtime-rs/src/constants.rs`, find the AVET version constant and change from 1 to 2. Look for `ECHO_TOP_WIRE_VERSION` or similar.

**Step 2: Rewrite `build_echo_top_wire`**

The current function (encoding.rs:123-161) writes the header then iterates cells writing 16-byte records. Replace the record loop with SoA writes:

```rust
// After writing the 64-byte header...
// SoA layout: all x_nm, then all z_nm, then all top arrays
for cell in &cells {
    buf.extend_from_slice(&cell.x_nm.to_le_bytes());
}
for cell in &cells {
    buf.extend_from_slice(&cell.z_nm.to_le_bytes());
}
for cell in &cells {
    buf.extend_from_slice(&cell.top18_feet.to_le_bytes());
}
for cell in &cells {
    buf.extend_from_slice(&cell.top30_feet.to_le_bytes());
}
for cell in &cells {
    buf.extend_from_slice(&cell.top50_feet.to_le_bytes());
}
for cell in &cells {
    buf.extend_from_slice(&cell.top60_feet.to_le_bytes());
}
```

**Step 3: Update content-type version**

In `services/runtime-rs/src/weather/mod.rs`, find the content type header for echo-tops (`application/vnd.approach-viz.echo-tops.v1`). Update to v2 if the version is part of the content type. If not, no change needed (the version field in the binary header is sufficient).

**Step 4: Run runtime tests**

Run:

```bash
cargo test -p approach-viz-runtime 2>&1
```

Expected: pass (no existing round-trip tests for echo-top encoding — the decoder is in the core crate).

**Step 5: Commit**

```bash
git add services/runtime-rs/src/weather/encoding.rs services/runtime-rs/src/constants.rs
git commit -m "feat(runtime): AVET v2 SoA echo-top encoder"
```

---

### Task 7: AVET v2 SoA Decoder (Echo-Tops)

**Files:**

- Modify: `crates/approach-viz-core/src/echo_top_wire_codec.rs` — rewrite decode loop
- Modify: `crates/approach-viz-core/src/types.rs:33` — update `ECHO_TOP_WIRE_VERSION` to 2

**Context:** The decoder reads the binary payload from the runtime. Update to expect SoA layout: contiguous arrays after the header instead of interleaved 16-byte records.

**Step 1: Update version constant**

In `crates/approach-viz-core/src/types.rs`, change:

```rust
pub const ECHO_TOP_WIRE_VERSION: u16 = 2;
```

Remove or update `ECHO_TOP_WIRE_CELL_BYTES` — it's no longer meaningful with SoA layout.

**Step 2: Write round-trip test**

In `crates/approach-viz-core/src/echo_top_wire_codec.rs`, add a test that builds a synthetic v2 SoA payload and decodes it:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_v2_soa_round_trip() {
        let n: u32 = 5;
        let mut buf = vec![0u8; 64]; // header

        // Magic + version
        buf[0..4].copy_from_slice(b"AVET");
        buf[4..6].copy_from_slice(&2u16.to_le_bytes()); // v2
        buf[6..8].copy_from_slice(&64u16.to_le_bytes()); // header_bytes
        buf[8..12].copy_from_slice(&n.to_le_bytes()); // cell_count
        buf[12..16].copy_from_slice(&n.to_le_bytes()); // source_cell_count
        buf[16..18].copy_from_slice(&1000u16.to_le_bytes()); // footprint_x_milli
        buf[18..20].copy_from_slice(&1000u16.to_le_bytes()); // footprint_y_milli
        // timestamps at 20..36 left as 0
        // max tops at 36..44 left as 0

        // SoA arrays: x_nm (f32), z_nm (f32), top18 (u16), top30, top50, top60
        for i in 0..n {
            buf.extend_from_slice(&(i as f32 * 1.0).to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&(i as f32 * -2.0).to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&((i * 1000 + 5000) as u16).to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&((i * 1000 + 10000) as u16).to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&((i * 1000 + 15000) as u16).to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&((i * 1000 + 20000) as u16).to_le_bytes());
        }

        let result = decode_echo_top_binary(&buf).unwrap();
        assert_eq!(result.cell_count, 5);
        assert_eq!(result.x_nm.len(), 5);
        assert_eq!(result.z_nm[2], -4.0);
        assert_eq!(result.top18_feet[0], 5000);
        assert_eq!(result.top60_feet[4], 24000);
    }
}
```

**Step 3: Run test to verify it fails**

Run:

```bash
cargo test -p approach-viz-core echo_top 2>&1
```

Expected: FAIL (decoder still expects v1 AoS layout).

**Step 4: Rewrite the decoder for SoA**

In `decode_echo_top_binary`, after header parsing, replace the per-record loop with SoA reads. Use `bytemuck::cast_slice` for zero-copy where possible:

```rust
use bytemuck;

// After header parsing, data_start = header_bytes
let records_start = header_bytes;

// Calculate offsets for each SoA array
let f32_size = 4;
let u16_size = 2;
let x_nm_offset = records_start;
let z_nm_offset = x_nm_offset + n * f32_size;
let top18_offset = z_nm_offset + n * f32_size;
let top30_offset = top18_offset + n * u16_size;
let top50_offset = top30_offset + n * u16_size;
let top60_offset = top50_offset + n * u16_size;

// Bounds check
let total_needed = top60_offset + n * u16_size;
if data.len() < total_needed {
    return Err(EchoTopDecodeError::TooShort { needed: total_needed, got: data.len() });
}

// Zero-copy reads (both platforms are little-endian)
let x_nm: Vec<f32> = bytemuck::cast_slice(&data[x_nm_offset..z_nm_offset]).to_vec();
let z_nm: Vec<f32> = bytemuck::cast_slice(&data[z_nm_offset..top18_offset]).to_vec();
let top18_feet: Vec<u16> = bytemuck::cast_slice(&data[top18_offset..top30_offset]).to_vec();
let top30_feet: Vec<u16> = bytemuck::cast_slice(&data[top30_offset..top50_offset]).to_vec();
let top50_feet: Vec<u16> = bytemuck::cast_slice(&data[top50_offset..top60_offset]).to_vec();
let top60_feet: Vec<u16> = bytemuck::cast_slice(&data[top60_offset..total_needed]).to_vec();
```

**Note:** `bytemuck::cast_slice` requires the source slice to be aligned. If alignment is not guaranteed (it may not be for arbitrary byte offsets), use `bytemuck::try_cast_slice` and fall back to manual reads. Alternatively, use `from_le_bytes` in a loop — it's still faster than the old AoS decode since there's no strided access.

**Step 5: Run tests**

Run:

```bash
cargo test -p approach-viz-core echo_top 2>&1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/approach-viz-core/src/echo_top_wire_codec.rs crates/approach-viz-core/src/types.rs
git commit -m "feat(core): AVET v2 SoA echo-top decoder with zero-copy reads"
```

---

### Task 8: AVMR v4 SoA Encoder (MRMS Volume)

**Files:**

- Modify: `services/runtime-rs/src/weather/encoding.rs:205-370` — change brick record writing in `build_volume_wire_impl`
- Modify: `services/runtime-rs/src/constants.rs` — update AVMR version

**Context:** The AVMR encoder is more complex than AVET — it filters, merges bricks, quantizes dBZ, then writes records. The SoA change only affects the final record-writing stage (lines ~347-360). Instead of writing 20-byte records, write contiguous arrays.

The header + level_bounds section stays the same. After level_bounds, write SoA arrays:

- `i16[brick_count]` x_hundredths
- `i16[brick_count]` z_hundredths
- `u16[brick_count]` bottom_feet
- `u16[brick_count]` top_feet
- `i16[brick_count]` dbz_tenths
- `u8[brick_count]` phase
- `u8[brick_count]` surface_phase
- `u16[brick_count]` span_x
- `u16[brick_count]` span_y
- `u16[brick_count]` span_z

**Step 1: Update version constant**

Change `WIRE_VERSION` from 3 to 4 in `services/runtime-rs/src/constants.rs`.

**Step 2: Refactor record writing to SoA**

The current code iterates bricks and writes 20-byte records inline. Refactor to:

1. First pass: collect all brick field values into temporary SoA vectors
2. Second pass: write each field array contiguously to the output buffer

```rust
// Collect into SoA during the brick iteration (which already exists)
let mut all_x: Vec<i16> = Vec::with_capacity(estimated_count);
let mut all_z: Vec<i16> = Vec::with_capacity(estimated_count);
// ... etc for each field

// During existing brick loop:
all_x.push(round_i16(brick.x_nm * 100.0));
all_z.push(round_i16(brick.z_nm * 100.0));
// ... etc

// After all bricks collected, write SoA arrays:
for &v in &all_x { buf.extend_from_slice(&v.to_le_bytes()); }
for &v in &all_z { buf.extend_from_slice(&v.to_le_bytes()); }
// ... etc for each field
```

**Step 3: Update record_bytes in header**

The `record_bytes` field at offset 18 is no longer meaningful with SoA layout. Set it to 0 or remove it. The v4 decoder should not rely on record_bytes.

**Step 4: Run tests**

Run:

```bash
cargo test -p approach-viz-runtime 2>&1
```

Expected: pass.

**Step 5: Commit**

```bash
git add services/runtime-rs/src/weather/encoding.rs services/runtime-rs/src/constants.rs
git commit -m "feat(runtime): AVMR v4 SoA volume encoder"
```

---

### Task 9: AVMR v4 SoA Decoder + SIMD i16→f32 Scaling

**Files:**

- Modify: `crates/approach-viz-core/src/mrms_wire_codec.rs` — rewrite decode loop for SoA
- Modify: `crates/approach-viz-core/src/types.rs:11` — update `MRMS_WIRE_VERSION` to 4

**Context:** The decoder reads the binary payload. Update to expect SoA layout. The x_nm and z_nm fields need i16→f32 conversion (divide by 100). Use `wide::i16x8` → widen to 2×`i32x4` → convert to `f32x4` → divide by `f32x4::splat(100.0)` for SIMD acceleration.

**Step 1: Update version constant**

```rust
pub const MRMS_WIRE_VERSION: u16 = 4;
```

**Step 2: Write round-trip test**

Similar to the echo-top test — build a synthetic v4 SoA buffer and decode it. Test i16→f32 scaling accuracy.

```rust
#[test]
fn decode_v4_soa_i16_to_f32_scaling() {
    // Build synthetic buffer with known i16 values
    // Verify x_nm[i] == hundredths[i] as f32 / 100.0
    let hundredths: Vec<i16> = vec![1234, -5678, 0, 100, 32767];
    // ... build buffer, decode, check
    for (i, &h) in hundredths.iter().enumerate() {
        assert!((result.x_nm[i] - h as f32 / 100.0).abs() < 1e-6);
    }
}
```

**Step 3: Implement SoA decoder with SIMD scaling**

After header + level_bounds parsing, compute SoA array offsets and decode:

```rust
use wide::{f32x4, i32x4};

// x_hundredths (i16) → x_nm (f32) with SIMD scaling
let x_raw: &[i16] = /* read from buffer */;
let mut x_nm = Vec::with_capacity(n);
let scale = f32x4::splat(1.0 / 100.0);

let chunks = n / 4;
for chunk in 0..chunks {
    let base = chunk * 4;
    let ints = i32x4::from([
        x_raw[base] as i32,
        x_raw[base + 1] as i32,
        x_raw[base + 2] as i32,
        x_raw[base + 3] as i32,
    ]);
    let floats = f32x4::from(ints) * scale;
    let arr = floats.to_array();
    x_nm.extend_from_slice(&arr);
}
// Scalar tail
for i in (chunks * 4)..n {
    x_nm.push(x_raw[i] as f32 / 100.0);
}

// Other fields: zero-copy cast (u16, i16, u8 arrays)
let bottom_feet: Vec<u16> = bytemuck::cast_slice(&data[bottom_offset..top_offset]).to_vec();
// ... etc

// footprint span: max(1, value)
for v in &mut footprint_x_span {
    *v = (*v).max(1);
}
```

**Note:** Check whether `wide` has `f32x4::from(i32x4)` or if you need `f32x4::from(ints.to_array())`. Consult docs.

**Step 4: Run tests**

Run:

```bash
cargo test -p approach-viz-core mrms 2>&1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/mrms_wire_codec.rs crates/approach-viz-core/src/types.rs
git commit -m "feat(core): AVMR v4 SoA decoder with SIMD i16-to-f32 scaling"
```

---

### Task 10: AVTR v2 SoA Encoder (Traffic)

**Files:**

- Modify: `services/runtime-rs/src/traffic/encoding.rs` — rewrite `encode_traffic_binary_payload` for SoA layout
- Update version constant in same file

**Context:** Traffic encoding has 3 sections (aircraft, history groups, history points) + string table. Each section converts to SoA independently. The string table stays as-is (variable-length strings can't be SoA).

**SoA layout for aircraft section:**

```
u32[a] hex_str_offset
u16[a] hex_str_length
u32[a] flight_str_offset
u16[a] flight_str_length
u16[a] flags
f32[a] lat
f32[a] lon
f32[a] altitude_feet
f32[a] ground_speed_kt
f32[a] track_deg
f32[a] last_seen_seconds
```

**SoA layout for history group section:**

```
u32[g] hex_str_offset
u16[g] hex_str_length
u32[g] point_start
u32[g] point_count
```

**SoA layout for history point section:**

```
f32[p] lat
f32[p] lon
f32[p] altitude_feet
i64[p] timestamp_ms
```

**Step 1: Update version constant**

```rust
const TRAFFIC_BINARY_VERSION: u16 = 2;
```

**Step 2: Rewrite encoding to collect SoA then write**

Instead of writing aircraft records inline (current lines 49-102), collect each field into a Vec, then write all of each field contiguously. Same for history groups and points.

The header structure stays the same (section offsets are still needed to locate the start of each section and the string table). Update offset calculations to account for SoA sizes.

**Step 3: Run tests**

Run:

```bash
cargo test -p approach-viz-runtime 2>&1
```

**Step 4: Commit**

```bash
git add services/runtime-rs/src/traffic/encoding.rs
git commit -m "feat(runtime): AVTR v2 SoA traffic encoder"
```

---

### Task 11: AVTR v2 SoA Decoder (Traffic)

**Files:**

- Modify: `crates/approach-viz-core/src/traffic_codec.rs` — rewrite decode for SoA
- Modify: `crates/approach-viz-core/src/types.rs:21` — update `TRAFFIC_WIRE_VERSION` to 2

**Context:** Traffic decoder is the most complex due to string table lookups and history grouping. The string table stays as-is. The SoA change affects how fixed-type fields are read.

**Step 1: Update version constant**

```rust
pub const TRAFFIC_WIRE_VERSION: u16 = 2;
```

**Step 2: Write round-trip test**

Build a synthetic v2 SoA traffic payload with known values, decode it, verify all fields.

**Step 3: Implement SoA decoder**

For each section, compute array offsets within the section and read contiguous slices:

```rust
// Aircraft section: read each SoA field array
let ac_start = aircraft_section_offset;
let hex_offsets_start = ac_start;
let hex_lengths_start = hex_offsets_start + aircraft_count * 4;
let flight_offsets_start = hex_lengths_start + aircraft_count * 2;
// ... etc for each field

// Read arrays
let hex_offsets: Vec<u32> = read_u32_array(data, hex_offsets_start, aircraft_count);
let hex_lengths: Vec<u16> = read_u16_array(data, hex_lengths_start, aircraft_count);
// ...

// Build DecodedTrafficAircraft from SoA columns
for i in 0..aircraft_count {
    aircraft.push(DecodedTrafficAircraft {
        hex: read_string(data, strings_offset, hex_offsets[i], hex_lengths[i])?,
        flight: read_optional_string(data, strings_offset, flight_offsets[i], flight_lengths[i])?,
        lat: lats[i],
        lon: lons[i],
        altitude_feet: nan_to_option(altitudes[i]),
        // ...
    });
}
```

**Step 4: Run tests**

Run:

```bash
cargo test -p approach-viz-core traffic 2>&1
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/traffic_codec.rs crates/approach-viz-core/src/types.rs
git commit -m "feat(core): AVTR v2 SoA traffic decoder"
```

---

### Task 12: Update WASM Bindings

**Files:**

- Modify: `crates/approach-viz-core/src/wasm.rs` — update any code that depends on wire format internals

**Context:** The WASM bindings call `decode_mrms_binary`, `decode_echo_top_binary`, `decode_traffic_binary`. Since those function signatures and output structs are unchanged, the WASM layer should work without changes. However, verify:

1. `decode_and_prepare_echo_top` still works end-to-end
2. `decode_and_prepare_mrms` still works end-to-end
3. `WasmTrafficState::merge` still works end-to-end

**Step 1: Check for any direct wire format access in wasm.rs**

Search `wasm.rs` for any hardcoded offsets, record sizes, or version numbers that need updating.

Run:

```bash
grep -n "WIRE\|RECORD\|VERSION\|HEADER_BYTES\|CELL_BYTES" crates/approach-viz-core/src/wasm.rs
```

If any hits reference old constants, update them.

**Step 2: Build WASM**

Run:

```bash
npm run build:wasm 2>&1
```

Expected: clean build.

**Step 3: Run core tests**

Run:

```bash
cargo test -p approach-viz-core 2>&1
```

Expected: all pass.

**Step 4: Commit (if any changes)**

```bash
git add crates/approach-viz-core/src/wasm.rs
git commit -m "refactor(core): update WASM bindings for SoA wire formats"
```

---

### Task 13: Update Benchmarks and CI

**Files:**

- Modify: `services/runtime-rs/benches/weather_ingest.rs` — add SIMD vs scalar benchmark comparisons
- Modify: `services/runtime-rs/vectorization-manifest.toml` — add `[[expect]]` entries if applicable
- Modify: `.github/workflows/parser-tests.yml` — ensure CI runs new tests

**Step 1: Add benchmark for SIMD filter vs scalar baseline**

In `benches/weather_ingest.rs`, add a group comparing scalar and SIMD filter:

```rust
// The existing filter_pass_baseline already benchmarks filter_voxels_by_threshold,
// which is now the SIMD version. Add a note in the benchmark name.
// No separate scalar benchmark needed since the old scalar code is gone.
```

**Step 2: Update vectorization manifest**

If the `wide`-based functions emit LLVM vectorization remarks (they may, since `wide` compiles to SIMD intrinsics not auto-vectorized loops), add expectations. If not, document why.

```toml
# Phase 2: Using explicit SIMD via `wide` crate — vectorization comes from
# wide's inline intrinsics, not LLVM auto-vectorization. LLVM remarks may
# not show these as "vectorized loops" since wide uses target-specific
# intrinsics directly. No [[expect]] entries needed for wide-based code.
```

**Step 3: Run full CI validation locally**

Run:

```bash
cargo test --workspace 2>&1
cargo bench -p approach-viz-runtime 2>&1
bash scripts/ci/check-vectorization.sh 2>&1
```

Expected: all pass.

**Step 4: Commit**

```bash
git add services/runtime-rs/benches/weather_ingest.rs services/runtime-rs/vectorization-manifest.toml
git commit -m "bench(runtime): update benchmarks and CI for SIMD Phase 2"
```

---

### Task 14: Integration Tests and WASM Smoke Tests

**Files:**

- No new files — run existing integration test suites

**Context:** The wire format changes affect the runtime↔client boundary. Integration tests verify the full pipeline.

**Step 1: Build everything**

Run:

```bash
cargo build -p approach-viz-runtime --release 2>&1
npm run build:wasm 2>&1
npm run build 2>&1
```

Expected: all clean.

**Step 2: Run runtime integration tests**

Start the runtime, then run integration tests:

Run:

```bash
npm run test:integration:runtime 2>&1
```

Expected: 3/3 pass (if runtime is running). These tests exercise the volume, echo-top, and traffic endpoints.

**Step 3: Run WASM smoke tests**

Start the dev server, then run WASM smoke tests:

Run:

```bash
npm run test:smoke 2>&1
```

Expected: pass. These test WASM decode paths in the browser.

**Step 4: Run all TS tests**

Run:

```bash
npm run test 2>&1
```

Expected: all pass.

**Step 5: Commit any fixes**

If integration tests revealed issues, fix and commit.

---

### Task 15: Final Verification and Benchmark Summary

**Step 1: Run complete test suite**

Run:

```bash
cargo test --workspace 2>&1
npm run test 2>&1
npm run typecheck 2>&1
npm run lint 2>&1
```

Expected: all pass.

**Step 2: Capture final benchmark numbers**

Run:

```bash
cargo bench -p approach-viz-runtime 2>&1
```

Record the numbers for:

- `filter_pass_baseline` — target: 5-10ms (was 30ms)
- `phase_scoring_branchless` — target: 75-100ms (was 300ms)

**Step 3: Update AGENTS.md if needed**

If wire format version numbers are documented in `AGENTS.md`, update them:

- `application/vnd.approach-viz.mrms.v3` → `v4` (or note new version)
- Any other version references

**Step 4: Final commit**

```bash
git add -A
git commit -m "docs: update wire format versions and benchmark results for SIMD Phase 2"
```
