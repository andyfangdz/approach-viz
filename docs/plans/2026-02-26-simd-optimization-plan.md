# SIMD Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure runtime hot loops for auto-vectorization with proven LLVM vectorization, criterion benchmarks, and CI regression detection.

**Architecture:** Multi-pass loop restructuring (filter → gather → compute → pack) to separate branches from arithmetic, enabling LLVM auto-vectorization. Branchless f32 predicated scoring replaces Option-chain phase classification. CI validates vectorization via LLVM remarks YAML.

**Tech Stack:** Rust (aarch64 NEON / x86_64 SSE4.2), criterion 0.5, LLVM optimization remarks, shell scripts for CI.

**Design doc:** `docs/plans/2026-02-26-simd-optimization-design.md`

---

## Phase 0: Benchmarks + CI Scaffold

### Task 1: Add criterion dependency and benchmark harness

**Files:**

- Modify: `services/runtime-rs/Cargo.toml`
- Create: `services/runtime-rs/benches/weather_ingest.rs`

**Step 1: Add criterion dev-dependency and bench target to Cargo.toml**

Add to `services/runtime-rs/Cargo.toml`:

```toml
[dev-dependencies]
criterion = { version = "0.5", features = ["html_reports"] }

[[bench]]
name = "weather_ingest"
harness = false
```

**Step 2: Create minimal benchmark file**

Create `services/runtime-rs/benches/weather_ingest.rs` with a placeholder that
imports criterion and defines an empty benchmark group. This verifies the
harness links and runs:

```rust
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_placeholder(c: &mut Criterion) {
    c.bench_function("placeholder", |b| {
        b.iter(|| std::hint::black_box(42))
    });
}

criterion_group!(benches, bench_placeholder);
criterion_main!(benches);
```

**Step 3: Verify harness builds and runs**

Run:

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest -- --quick
```

Expected: builds cleanly, runs placeholder benchmark, prints timing.

**Step 4: Commit**

```bash
git add services/runtime-rs/Cargo.toml services/runtime-rs/benches/weather_ingest.rs
git commit -m "build(runtime): add criterion benchmark harness"
```

---

### Task 2: Write synthetic data generator for benchmarks

**Files:**

- Create: `services/runtime-rs/benches/fixtures.rs`
- Modify: `services/runtime-rs/benches/weather_ingest.rs`

**Step 1: Create fixtures module with synthetic grid generator**

Create `services/runtime-rs/benches/fixtures.rs`. This generates deterministic
test data matching real MRMS dimensions. Key parameters:

- Grid: 3500×3500 (matches MRMS CONUS grid)
- ~30% fill rate for dbz_tenths >= STORE_MIN_DBZ_TENTHS (50)
- Seeded RNG for reproducibility
- Aux fields: 7 flat f32 arrays with ~80% coverage (rest NaN)
- ZDR/RhoHV: 2 flat f32 arrays per level with ~90% coverage

The generator should produce:

- `dbz_tenths: Vec<i16>` — length nx×ny, values seeded with ~30% above threshold
- `zdr_values: Vec<f32>` — length nx×ny, 90% finite values in [-2.0, 3.0], 10% NaN
- `rhohv_values: Vec<f32>` — length nx×ny, 90% finite values in [0.85, 1.01], 10% NaN
- `aux_values: [Vec<f32>; 7]` — length nx×ny each, 80% finite, 20% NaN
  - Index 0: precip_flag (discrete: 0.0, 1.0, 3.0, 7.0)
  - Index 1: freezing_level (meters: 2000-5000 range)
  - Index 2: wet_bulb_temp (Celsius or Kelvin: -5.0 to 5.0 or 268-278)
  - Index 3: surface_temp (Celsius or Kelvin: -2.0 to 4.0 or 271-277)
  - Index 4: bright_band_top (meters: 3000-5000)
  - Index 5: bright_band_bottom (meters: 2500-4500)
  - Index 6: rqi (0.0-1.0)

Use a simple LCG or xorshift seeded from a constant for reproducibility.
Do NOT add a dependency on `rand` — use a minimal inline PRNG:

```rust
struct SimpleRng(u64);
impl SimpleRng {
    fn new(seed: u64) -> Self { Self(seed) }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.0
    }
    fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn next_bool(&mut self, probability: f32) -> bool {
        self.next_f32() < probability
    }
}
```

**Step 2: Update weather_ingest.rs to use fixtures**

Add `mod fixtures;` to the benchmark file. Replace the placeholder with a
benchmark that calls `fixtures::generate_grid(3500, 3500)` and iterates the
dbz_tenths array with a threshold filter (simulating Pass 1):

```rust
mod fixtures;
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_filter_pass(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;

    c.bench_function("filter_pass_baseline", |b| {
        b.iter(|| {
            let mut valid = Vec::with_capacity(data.dbz_tenths.len() / 3);
            for (i, &dbz) in data.dbz_tenths.iter().enumerate() {
                if dbz >= threshold {
                    valid.push(i as u32);
                }
            }
            std::hint::black_box(valid.len())
        })
    });
}

criterion_group!(benches, bench_filter_pass);
criterion_main!(benches);
```

**Step 3: Run benchmark to capture baseline**

Run:

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest
```

Expected: prints timing for `filter_pass_baseline`. Record the number.

**Step 4: Commit**

```bash
git add services/runtime-rs/benches/fixtures.rs services/runtime-rs/benches/weather_ingest.rs
git commit -m "bench(runtime): add synthetic grid generator and filter pass baseline"
```

---

### Task 3: Add phase scoring baseline benchmark

**Files:**

- Modify: `services/runtime-rs/benches/weather_ingest.rs`

**Step 1: Add benchmark for current scalar phase scoring**

Add a benchmark that calls `resolve_thermo_phase` in a loop over the generated
aux values. This function is in `approach_viz_runtime::weather::phase` but it's
`pub(super)` — the benchmark can't call it directly. Instead, inline a copy of
the scoring logic or extract the scoring into a `pub(crate)` function.

**Preferred approach:** Add `#[cfg(feature = "bench-internals")]` to expose
phase scoring functions for benchmarks.

In `services/runtime-rs/Cargo.toml`, add:

```toml
[features]
bench-internals = []

[[bench]]
name = "weather_ingest"
harness = false
required-features = ["bench-internals"]
```

In `services/runtime-rs/src/weather/phase.rs`, change the visibility of
`resolve_thermo_phase` and `resolve_dual_pol_evidence`:

```rust
#[cfg_attr(feature = "bench-internals", visibility::make(pub))]
pub(super) fn resolve_thermo_phase(...) -> ThermoPhaseEvidence {
```

Actually, the simpler approach: just change `pub(super)` to `pub(crate)` on:

- `resolve_thermo_phase`
- `resolve_dual_pol_evidence`
- `resolve_phase_from_evidence`
- `ThermoPhaseEvidence`
- `DualPolEvidence`
- `PhaseScores`
- `PhaseResolution`
- `LevelPhaseVoxel`

These are already used across the weather module. Making them `pub(crate)`
allows benchmarks (which are in the same crate) to access them.

**Step 2: Write the benchmark**

```rust
fn bench_phase_scoring(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;
    let voxel_mid_feet: f64 = 15_000.0;

    // Pre-filter to get valid indices
    let valid: Vec<usize> = data.dbz_tenths.iter().enumerate()
        .filter(|(_, &d)| d >= threshold)
        .map(|(i, _)| i)
        .collect();

    c.bench_function("phase_scoring_baseline", |b| {
        b.iter(|| {
            let mut rain_count = 0u32;
            let mut snow_count = 0u32;
            for &i in &valid {
                let evidence = resolve_thermo_phase(
                    voxel_mid_feet,
                    nan_to_option(data.aux_values[0][i]),
                    nan_to_option(data.aux_values[1][i]),
                    nan_to_option(data.aux_values[2][i]),
                    nan_to_option(data.aux_values[3][i]),
                    nan_to_option(data.aux_values[4][i]),
                    nan_to_option(data.aux_values[5][i]),
                    nan_to_option(data.aux_values[6][i]),
                );
                match evidence.phase {
                    0 => rain_count += 1,
                    2 => snow_count += 1,
                    _ => {}
                }
            }
            std::hint::black_box((rain_count, snow_count))
        })
    });
}

fn nan_to_option(v: f32) -> Option<f32> {
    if v.is_finite() { Some(v) } else { None }
}
```

**Step 3: Run and record baseline**

Run:

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest
```

Record `phase_scoring_baseline` timing.

**Step 4: Commit**

```bash
git add services/runtime-rs/src/weather/phase.rs services/runtime-rs/benches/weather_ingest.rs services/runtime-rs/Cargo.toml
git commit -m "bench(runtime): add phase scoring baseline benchmark"
```

---

### Task 4: Create CI vectorization check scaffold

**Files:**

- Create: `services/runtime-rs/vectorization-manifest.toml`
- Create: `scripts/ci/check-vectorization.sh`

**Step 1: Create empty manifest**

Create `services/runtime-rs/vectorization-manifest.toml`:

```toml
# Vectorization expectations for CI regression detection.
#
# Each [[expect]] entry declares a function that MUST be auto-vectorized.
# CI fails if LLVM optimization remarks don't show vectorization for any
# listed function.
#
# Fields:
#   function    — Rust symbol substring to match in LLVM remark output
#   min_width   — minimum vectorization width (f32=4, i16=8, f64=2 on NEON)
#   description — human-readable note for failure messages
#
# Add new entries in the same PR that adds the vectorized code.

# (empty — entries added in Phase 1)
```

**Step 2: Create check script**

Create `scripts/ci/check-vectorization.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${1:-services/runtime-rs/vectorization-manifest.toml}"
REMARKS_FILE="${2:-target/vectorization-remarks.yaml}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi

# Count expected entries
expected_count=$(grep -c '^\[\[expect\]\]' "$MANIFEST" || true)
if [[ "$expected_count" -eq 0 ]]; then
  echo "No vectorization expectations in manifest — skipping check."
  exit 0
fi

# Build with LLVM vectorization remarks
echo "Building with LLVM vectorization remarks..."
RUSTFLAGS="-C llvm-args=-pass-remarks=loop-vectorize \
           -C llvm-args=-pass-remarks-output=${REMARKS_FILE} \
           -C llvm-args=-pass-remarks-format=yaml \
           ${RUSTFLAGS:-}" \
  cargo build --release -p approach-viz-runtime 2>&1

if [[ ! -f "$REMARKS_FILE" ]]; then
  echo "ERROR: Remarks file not generated at $REMARKS_FILE" >&2
  exit 1
fi

# Parse manifest and check each expectation
pass=0
fail=0
while IFS= read -r line; do
  # Extract fields from TOML (simple line-by-line parser)
  if [[ "$line" == "[[expect]]" ]]; then
    func="" width="" desc=""
  elif [[ "$line" =~ ^function\ *=\ *\"(.+)\" ]]; then
    func="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^min_width\ *=\ *([0-9]+) ]]; then
    width="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^description\ *=\ *\"(.+)\" ]]; then
    desc="${BASH_REMATCH[1]}"
    # All fields collected — check this expectation
    if grep -q "Function:.*${func}" "$REMARKS_FILE" 2>/dev/null; then
      # Check width if YAML contains VectorizationFactor or Width
      found_width=$(grep -A5 "Function:.*${func}" "$REMARKS_FILE" \
        | grep -oP 'Width:\s*\K[0-9]+' | head -1 || echo "0")
      if [[ "$found_width" -ge "$width" ]]; then
        echo "  PASS: ${func} (width=${found_width} >= ${width})"
        pass=$((pass + 1))
      else
        echo "  FAIL: ${func} — vectorized but width ${found_width} < required ${width}"
        echo "        ${desc}"
        fail=$((fail + 1))
      fi
    else
      echo "  FAIL: ${func} — NOT FOUND in vectorization remarks"
      echo "        ${desc}"
      fail=$((fail + 1))
    fi
  fi
done < "$MANIFEST"

echo ""
echo "Vectorization check: ${pass} passed, ${fail} failed (of ${expected_count} expected)"

if [[ "$fail" -gt 0 ]]; then
  echo ""
  echo "REGRESSION DETECTED: ${fail} loop(s) lost vectorization."
  echo "Check the code changes for branches or type conversions that block LLVM."
  exit 1
fi
```

**Step 3: Make script executable and verify it runs (no-op with empty manifest)**

Run:

```bash
chmod +x scripts/ci/check-vectorization.sh
bash scripts/ci/check-vectorization.sh
```

Expected: prints "No vectorization expectations in manifest — skipping check." and exits 0.

**Step 4: Commit**

```bash
git add services/runtime-rs/vectorization-manifest.toml scripts/ci/check-vectorization.sh
git commit -m "ci: add vectorization regression check scaffold"
```

---

### Task 5: Add vectorization check to CI workflow

**Files:**

- Modify: `.github/workflows/parser-tests.yml`

**Step 1: Add Rust toolchain and vectorization check job**

Add a new job to `.github/workflows/parser-tests.yml` after the existing
`checks` job:

```yaml
rust-checks:
  runs-on: ubuntu-latest
  timeout-minutes: 30
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Rust
      uses: dtolnay/rust-toolchain@stable

    - name: Cache cargo
      uses: actions/cache@v4
      with:
        path: |
          ~/.cargo/registry
          ~/.cargo/git
          target
        key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}

    - name: Cargo check
      run: cargo check --workspace

    - name: Cargo test
      run: cargo test --workspace

    - name: Vectorization regression check
      run: bash scripts/ci/check-vectorization.sh
```

**Step 2: Verify CI config is valid YAML**

Run:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/parser-tests.yml'))" && echo "YAML valid"
```

Expected: "YAML valid"

**Step 3: Commit**

```bash
git add .github/workflows/parser-tests.yml
git commit -m "ci: add Rust checks and vectorization regression job"
```

---

## Phase 1: processor.rs Multi-Pass Restructure

### Task 6: Extract filter pass function

**Files:**

- Modify: `services/runtime-rs/src/weather/processor.rs`

**Step 1: Write a test for the filter pass**

Add a test in `services/runtime-rs/src/weather/processor.rs` (or a new test
module) that verifies filter_voxels_by_threshold:

```rust
#[cfg(test)]
mod filter_tests {
    use super::*;

    #[test]
    fn filter_voxels_by_threshold_selects_above_threshold() {
        let dbz = vec![10_i16, 60, -50, 50, 100, 49, 51];
        let threshold = 50_i16;
        let result = filter_voxels_by_threshold(&dbz, threshold);
        assert_eq!(result, vec![1_u32, 3, 4, 6]);
    }

    #[test]
    fn filter_voxels_by_threshold_empty_input() {
        let result = filter_voxels_by_threshold(&[], 50);
        assert!(result.is_empty());
    }

    #[test]
    fn filter_voxels_by_threshold_all_below() {
        let dbz = vec![10_i16, 20, 30, 40, 49];
        let result = filter_voxels_by_threshold(&dbz, 50);
        assert!(result.is_empty());
    }
}
```

**Step 2: Run to verify it fails**

Run:

```bash
cd services/runtime-rs && cargo test filter_voxels_by_threshold
```

Expected: FAIL — function doesn't exist yet.

**Step 3: Implement filter_voxels_by_threshold**

Add to `services/runtime-rs/src/weather/processor.rs`:

```rust
/// Pass 1: Scan dbz_tenths and collect indices of voxels at or above threshold.
///
/// Designed for auto-vectorization: single contiguous array, simple comparison,
/// no branches in the hot path. LLVM should vectorize the comparison to 8×i16
/// on NEON (aarch64) or 16×i16 on AVX2 (x86_64).
#[inline(never)]  // Preserve as distinct function for LLVM remarks + asm inspection
pub(crate) fn filter_voxels_by_threshold(dbz_tenths: &[i16], threshold: i16) -> Vec<u32> {
    let mut valid = Vec::with_capacity(dbz_tenths.len() / 3);
    for (i, &dbz) in dbz_tenths.iter().enumerate() {
        if dbz >= threshold {
            valid.push(i as u32);
        }
    }
    valid
}
```

Note: `#[inline(never)]` keeps this as a named function in LLVM remarks so the
CI vectorization check can match on it. The function is called once per level,
not in a tight inner loop, so preventing inlining has no performance cost.

**Step 4: Run tests**

Run:

```bash
cd services/runtime-rs && cargo test filter_voxels_by_threshold
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add services/runtime-rs/src/weather/processor.rs
git commit -m "feat(runtime): extract filter_voxels_by_threshold (Pass 1)"
```

---

### Task 7: Extract gather pass function

**Files:**

- Modify: `services/runtime-rs/src/weather/processor.rs`

**Step 1: Define GatheredAuxFields struct and write tests**

The gather pass collects aux values for valid voxel indices into flat f32
arrays, using NaN as sentinel for missing values.

```rust
pub(crate) struct GatheredAuxFields {
    pub(crate) zdr: Vec<f32>,
    pub(crate) rhohv: Vec<f32>,
    pub(crate) precip_flag: Vec<f32>,
    pub(crate) freezing_level: Vec<f32>,
    pub(crate) wet_bulb: Vec<f32>,
    pub(crate) surface_temp: Vec<f32>,
    pub(crate) bright_band_top: Vec<f32>,
    pub(crate) bright_band_bottom: Vec<f32>,
    pub(crate) rqi: Vec<f32>,
}
```

Test:

```rust
#[test]
fn gather_aux_fields_uses_nan_for_missing() {
    // Construct AuxFieldSamplers with partial coverage
    // Verify output has NaN at expected positions
}
```

**Step 2: Implement gather_aux_fields**

```rust
pub(crate) fn gather_aux_fields(
    valid_indices: &[u32],
    nx: u32,
    zdr_values: Option<&[f32]>,
    rhohv_values: Option<&[f32]>,
    precip_sampler: &AuxFieldSampler,
    freezing_sampler: &AuxFieldSampler,
    wet_bulb_sampler: &AuxFieldSampler,
    surface_temp_sampler: &AuxFieldSampler,
    bright_band_top_sampler: &AuxFieldSampler,
    bright_band_bottom_sampler: &AuxFieldSampler,
    rqi_sampler: &AuxFieldSampler,
) -> GatheredAuxFields {
    let n = valid_indices.len();
    let mut out = GatheredAuxFields {
        zdr: vec![f32::NAN; n],
        rhohv: vec![f32::NAN; n],
        precip_flag: vec![f32::NAN; n],
        freezing_level: vec![f32::NAN; n],
        wet_bulb: vec![f32::NAN; n],
        surface_temp: vec![f32::NAN; n],
        bright_band_top: vec![f32::NAN; n],
        bright_band_bottom: vec![f32::NAN; n],
        rqi: vec![f32::NAN; n],
    };
    for (out_i, &idx) in valid_indices.iter().enumerate() {
        let value_idx = idx as usize;
        let row = value_idx / nx as usize;
        let col = value_idx % nx as usize;

        if let Some(vals) = zdr_values {
            if let Some(&v) = vals.get(value_idx) {
                out.zdr[out_i] = v;
            }
        }
        if let Some(vals) = rhohv_values {
            if let Some(&v) = vals.get(value_idx) {
                out.rhohv[out_i] = v;
            }
        }
        if let Some(v) = precip_sampler.sample(value_idx, row, col) {
            out.precip_flag[out_i] = v;
        }
        if let Some(v) = freezing_sampler.sample(value_idx, row, col) {
            out.freezing_level[out_i] = v;
        }
        if let Some(v) = wet_bulb_sampler.sample(value_idx, row, col) {
            out.wet_bulb[out_i] = v;
        }
        if let Some(v) = surface_temp_sampler.sample(value_idx, row, col) {
            out.surface_temp[out_i] = v;
        }
        if let Some(v) = bright_band_top_sampler.sample(value_idx, row, col) {
            out.bright_band_top[out_i] = v;
        }
        if let Some(v) = bright_band_bottom_sampler.sample(value_idx, row, col) {
            out.bright_band_bottom[out_i] = v;
        }
        if let Some(v) = rqi_sampler.sample(value_idx, row, col) {
            out.rqi[out_i] = v;
        }
    }
    out
}
```

**Step 3: Run tests**

```bash
cd services/runtime-rs && cargo test gather_aux_fields
```

**Step 4: Commit**

```bash
git add services/runtime-rs/src/weather/processor.rs
git commit -m "feat(runtime): extract gather_aux_fields (Pass 2)"
```

---

### Task 8: Implement branchless phase scoring (Pass 3)

**Files:**

- Create: `services/runtime-rs/src/weather/phase_batch.rs`
- Modify: `services/runtime-rs/src/weather/mod.rs`

This is the critical vectorization target. The function processes flat f32
arrays with branchless predicated arithmetic.

**Step 1: Write equivalence test**

Before writing the branchless version, write a test that generates random
inputs and asserts the branchless scorer produces identical output to the
existing `resolve_thermo_phase` for every input:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::weather::phase::resolve_thermo_phase;

    fn nan_to_option(v: f32) -> Option<f32> {
        if v.is_finite() { Some(v) } else { None }
    }

    #[test]
    fn branchless_matches_scalar_for_random_inputs() {
        // Use same SimpleRng as benchmarks for reproducibility
        let mut rng = SimpleRng::new(12345);
        let n = 10_000;
        let voxel_mid_feet = 15_000.0_f32;

        let precip: Vec<f32> = (0..n).map(|_| if rng.next_bool(0.8) {
            [0.0, 1.0, 3.0, 7.0][rng.next_u64() as usize % 4]
        } else { f32::NAN }).collect();
        // ... generate freezing, wet_bulb, surface_temp, bb_top, bb_bottom, rqi

        for i in 0..n {
            let scalar = resolve_thermo_phase(
                voxel_mid_feet as f64,
                nan_to_option(precip[i]),
                nan_to_option(freezing[i]),
                nan_to_option(wet_bulb[i]),
                nan_to_option(surface_temp[i]),
                nan_to_option(bb_top[i]),
                nan_to_option(bb_bottom[i]),
                nan_to_option(rqi[i]),
            );
            let batch = compute_phase_scores_branchless_single(
                voxel_mid_feet, &precip, &freezing, &wet_bulb,
                &surface_temp, &bb_top, &bb_bottom, &rqi, i,
            );
            assert_eq!(scalar.phase, batch.phase,
                "phase mismatch at index {i}");
        }
    }
}
```

**Step 2: Implement compute_phase_scores_branchless**

Create `services/runtime-rs/src/weather/phase_batch.rs`. This is the batch
version of `resolve_thermo_phase` that operates on flat f32 arrays:

```rust
use crate::constants::*;

pub(crate) struct BatchPhaseResult {
    pub(crate) phase: Vec<u8>,
    pub(crate) surface_phase: Vec<u8>,
    pub(crate) transition_candidate: Vec<bool>,
    pub(crate) signal_count: Vec<u8>,
    // Diagnostic flags for tally pass
    pub(crate) used_dual: Vec<bool>,
    pub(crate) suppressed_dual: Vec<bool>,
    pub(crate) suppressed_mixed: Vec<bool>,
    pub(crate) forced_precip_snow: Vec<bool>,
}

/// Branchless batch phase scoring over flat f32 arrays.
///
/// NaN in any aux array means "missing" — NaN comparisons produce false,
/// so the mask is 0.0 and that signal contributes zero score.
///
/// Designed for auto-vectorization: all f32, no branches, no Option types.
/// LLVM should vectorize to 4×f32 on NEON.
#[inline(never)]
pub(crate) fn compute_phase_scores_branchless(
    voxel_mid_feet: f32,
    precip_flag: &[f32],
    freezing_level: &[f32],
    wet_bulb: &[f32],
    surface_temp: &[f32],
    bright_band_top: &[f32],
    bright_band_bottom: &[f32],
    rqi: &[f32],
    zdr: &[f32],
    rhohv: &[f32],
    use_aux_fallback: bool,
) -> BatchPhaseResult {
    let n = precip_flag.len();
    // ... allocate output vectors with capacity n
    // ... iterate i in 0..n with branchless scoring
    // See design doc for the predicated arithmetic pattern
    todo!()
}
```

The scoring loop body for each voxel follows this pattern for every signal
source (shown here for freezing level — repeat analogously for wet_bulb,
surface_temp, bright_band, precip_flag):

```rust
// Freezing level signal
let freezing_raw = freezing_level[i];
let freezing_valid = freezing_raw.is_finite() && freezing_raw > 0.0;
let fmask = freezing_valid as u32 as f32;  // 0.0 or 1.0
let freezing_meters = if freezing_valid { freezing_raw } else { 0.0 };
let freezing_feet = freezing_meters * FEET_PER_METER_F32;
let delta_feet = voxel_mid_feet - freezing_feet;

// Near-transition flag
let near_freezing = delta_feet.abs() <= THERMO_NEAR_FREEZING_FEET_F32;
near_transition |= freezing_valid && near_freezing;

// Score contributions (branchless)
let very_cold = (delta_feet >= 2500.0) as u32 as f32;
let cold = ((delta_feet >= THERMO_NEAR_FREEZING_FEET_F32) as u32 as f32) * (1.0 - very_cold);
let very_warm = (delta_feet <= -2500.0) as u32 as f32;
let warm = ((delta_feet <= -THERMO_NEAR_FREEZING_FEET_F32) as u32 as f32) * (1.0 - very_warm);
let middle = 1.0 - very_cold - cold - very_warm - warm;
let mid_cold = (delta_feet >= 0.0) as u32 as f32;

// Freezing level phase scoring
signal_count += fmask as u8;
// Phase from freezing level (simplified: above + transition → PHASE_SNOW)
let fl_phase_weight = 0.6;
let fl_above = (delta_feet >= FREEZING_LEVEL_TRANSITION_FEET_F32) as u32 as f32;
let fl_below = (delta_feet <= -FREEZING_LEVEL_TRANSITION_FEET_F32) as u32 as f32;
snow_score  += fmask * (fl_above * fl_phase_weight);
rain_score  += fmask * (fl_below * fl_phase_weight);
mixed_score += fmask * ((1.0 - fl_above - fl_below) * fl_phase_weight);

// Altitude-based scoring
snow_score  += fmask * (very_cold * 2.4 + cold * 1.8 + middle * mid_cold * 0.8);
rain_score  += fmask * (very_warm * 2.4 + warm * 1.8 + middle * (1.0 - mid_cold) * 0.8);
mixed_score += fmask * (cold * 0.5 + warm * 0.5 + middle * 1.6);
```

The key insight: every `if` becomes a multiplication by 0.0 or 1.0. The
compiler can vectorize multiplications and additions without branches.

**Step 3: Run equivalence test**

```bash
cd services/runtime-rs && cargo test branchless_matches_scalar
```

Expected: PASS — branchless and scalar produce identical phase codes.

**Step 4: Add to benchmark**

Add to `weather_ingest.rs`:

```rust
fn bench_phase_scoring_branchless(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let valid = filter_voxels_by_threshold(&data.dbz_tenths, 50);
    let gathered = /* gather aux fields for valid indices */;

    c.bench_function("phase_scoring_branchless", |b| {
        b.iter(|| {
            std::hint::black_box(compute_phase_scores_branchless(
                15_000.0,
                &gathered.precip_flag,
                &gathered.freezing_level,
                &gathered.wet_bulb,
                &gathered.surface_temp,
                &gathered.bright_band_top,
                &gathered.bright_band_bottom,
                &gathered.rqi,
                &gathered.zdr,
                &gathered.rhohv,
                false,
            ))
        })
    });
}
```

**Step 5: Run benchmark, compare against baseline**

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest
```

Expected: `phase_scoring_branchless` should be faster than `phase_scoring_baseline`.

**Step 6: Commit**

```bash
git add services/runtime-rs/src/weather/phase_batch.rs services/runtime-rs/src/weather/mod.rs services/runtime-rs/benches/weather_ingest.rs
git commit -m "feat(runtime): add branchless batch phase scoring (Pass 3)"
```

---

### Task 9: Verify auto-vectorization with LLVM remarks

**Files:**

- Modify: `services/runtime-rs/vectorization-manifest.toml`

**Step 1: Run build with LLVM remarks**

```bash
cd services/runtime-rs && \
RUSTFLAGS="-C llvm-args=-pass-remarks=loop-vectorize \
           -C llvm-args=-pass-remarks-output=../../target/vectorization-remarks.yaml \
           -C llvm-args=-pass-remarks-format=yaml \
           -C force-frame-pointers=yes" \
  cargo build --release
```

**Step 2: Search for vectorized functions in remarks**

```bash
grep -A2 "filter_voxels_by_threshold\|compute_phase_scores_branchless" target/vectorization-remarks.yaml
```

Expected: both functions appear with vectorization remarks showing width >= 4.

If a function is NOT vectorized, investigate:

- Check for remaining branches in the hot loop
- Look for type conversions (i16→f32 in same expression)
- Check if `#[inline(never)]` is preventing vectorization of the loop body
  (if so, move the loop to a separate inner function that IS inlined)

**Step 3: Inspect assembly (optional but recommended)**

```bash
cargo install cargo-show-asm  # if not installed
cd services/runtime-rs && cargo asm --bench weather_ingest filter_voxels_by_threshold --rust
```

On aarch64: look for `cmge v*.8h` (8×i16 comparison) or `fcmge v*.4s` (4×f32).
On x86_64: look for `vpcmpgtw` (AVX2 i16) or `vcmpps` (AVX f32).

**Step 4: Populate vectorization manifest**

Update `services/runtime-rs/vectorization-manifest.toml`:

```toml
[[expect]]
function = "filter_voxels_by_threshold"
min_width = 8
description = "i16 dbz threshold scan in processor.rs Pass 1"

[[expect]]
function = "compute_phase_scores_branchless"
min_width = 4
description = "f32 predicated phase scoring in processor.rs Pass 3"
```

**Step 5: Run CI check to verify it passes**

```bash
bash scripts/ci/check-vectorization.sh
```

Expected: 2 passed, 0 failed.

**Step 6: Commit**

```bash
git add services/runtime-rs/vectorization-manifest.toml
git commit -m "ci: populate vectorization manifest with Phase 1 expectations"
```

---

### Task 10: Wire the multi-pass pipeline into ingest_timestamp

**Files:**

- Modify: `services/runtime-rs/src/weather/processor.rs`

**Step 1: Replace the monolithic loop**

Replace the loop at lines 332-413 with calls to the four pass functions.
The outer structure stays the same (iterating `levels`), but the inner
row×col loop becomes:

```rust
// Pass 1: Filter
let valid_indices = filter_voxels_by_threshold(&parsed.dbz_tenths, STORE_MIN_DBZ_TENTHS);

// Pass 2: Gather
let gathered = gather_aux_fields(
    &valid_indices, parsed.grid.nx,
    zdr_values, rhohv_values,
    &precip_sampler, &freezing_sampler, &wet_bulb_sampler,
    &surface_temp_sampler, &bright_band_top_sampler,
    &bright_band_bottom_sampler, &rqi_sampler,
);

// Pass 3: Phase scoring
let voxel_mid_feet_f32 = voxel_mid_feet as f32;
let batch_result = compute_phase_scores_branchless(
    voxel_mid_feet_f32,
    &gathered.precip_flag, &gathered.freezing_level,
    &gathered.wet_bulb, &gathered.surface_temp,
    &gathered.bright_band_top, &gathered.bright_band_bottom,
    &gathered.rqi, &gathered.zdr, &gathered.rhohv,
    use_aux_fallback,
);

// Pass 4: Tally + Pack
let nx = parsed.grid.nx as usize;
for (out_i, &idx) in valid_indices.iter().enumerate() {
    let value_idx = idx as usize;
    let row = (value_idx / nx) as u16;
    let col = (value_idx % nx) as u16;

    // Tally counters from batch_result flags
    if batch_result.used_dual[out_i] { dual_adjusted_voxel_count += 1; }
    if batch_result.suppressed_dual[out_i] { dual_suppressed_voxel_count += 1; }
    if batch_result.suppressed_mixed[out_i] { mixed_suppressed_voxel_count += 1; }
    if batch_result.forced_precip_snow[out_i] { precip_snow_forced_voxel_count += 1; }
    if batch_result.signal_count[out_i] > 0 {
        thermo_signal_voxel_count += 1;
    } else {
        thermo_no_signal_voxel_count += 1;
    }

    level_voxels.push(LevelPhaseVoxel {
        row, col,
        dbz_tenths: parsed.dbz_tenths[value_idx],
        phase: batch_result.phase[out_i],
        surface_phase: batch_result.surface_phase[out_i],
        transition_candidate: batch_result.transition_candidate[out_i],
    });
}
```

**Step 2: Run all existing tests**

```bash
cd services/runtime-rs && cargo test
```

Expected: all 21 tests pass. The phase tests in phase.rs validate the scalar
path which is still used by the equivalence test.

**Step 3: Run benchmarks to measure end-to-end improvement**

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest
```

Compare `filter_pass_baseline` and `phase_scoring_branchless` vs baselines.

**Step 4: Run integration tests against deployed service**

Note: this requires deploying the updated binary first. See deploy steps in
AGENTS.md. After deploy:

```bash
npm run test:integration:runtime
```

Expected: 3/3 pass.

**Step 5: Commit**

```bash
git add services/runtime-rs/src/weather/processor.rs
git commit -m "refactor(runtime): wire multi-pass pipeline into ingest_timestamp"
```

---

### Task 11: Final verification and deploy

**Step 1: Run full test suite**

```bash
cd services/runtime-rs && cargo test
```

**Step 2: Run vectorization check**

```bash
bash scripts/ci/check-vectorization.sh
```

**Step 3: Run benchmarks and record final numbers**

```bash
cd services/runtime-rs && cargo bench --bench weather_ingest
```

Document baseline vs optimized timings in a commit message or PR description.

**Step 4: Deploy to OCI**

```bash
RUNTIME_MRMS_SQS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/360132101973/approach-viz-mrms-oci-useast-arm-4" \
  RUNTIME_DEPLOY_BUILD_MODE=local-cross \
  RUNTIME_LOCAL_CROSS_TOOL=zigbuild \
  scripts/runtime/deploy_oci.sh ubuntu@100.86.128.122
```

**Step 5: Run integration tests**

```bash
npm run test:integration:runtime
```

**Step 6: Commit with benchmark results**

```bash
git add -A
git commit -m "perf(runtime): Phase 0+1 complete — multi-pass vectorized ingest

Benchmarks (aarch64):
  filter_pass:    Xms → Yms (N.Nx speedup)
  phase_scoring:  Xms → Yms (N.Nx speedup)

Vectorization verified: filter (8×i16), scoring (4×f32)"
```
