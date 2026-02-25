# approach-viz-core Crate Extraction Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract client-side compute kernels into a shared Rust crate (`approach-viz-core`) that compiles to native (for runtime-rs and future iOS) and `wasm32` (for browser workers).

**Architecture:** Pure-compute Rust crate with zero I/O, zero async. Exposes coordinate transforms, binary wire decoders (AVMR/AVTR), MRMS voxel preprocessing, traffic merge/projection, and FNV hashing. Workers keep orchestration (fetch, SAB, postMessage) in TypeScript and call WASM for compute. Runtime-rs replaces duplicated math with core crate imports.

**Tech Stack:** Rust (no_std-compatible where possible), wasm-bindgen, wasm-pack, byteorder (or manual LE reads)

---

## Phase 1: Core Crate Foundation

### Task 1: Cargo Workspace + Crate Skeleton

**Files:**

- Create: `Cargo.toml` (workspace root)
- Create: `crates/approach-viz-core/Cargo.toml`
- Create: `crates/approach-viz-core/src/lib.rs`
- Modify: `services/runtime-rs/Cargo.toml` (add workspace member + core dep)
- Modify: `.gitignore` (add `crates/*/target/` if needed)

**Step 1: Create workspace root Cargo.toml**

```toml
# Cargo.toml (project root)
[workspace]
members = [
    "crates/approach-viz-core",
    "services/runtime-rs",
]
resolver = "2"
```

**Step 2: Create core crate directory and Cargo.toml**

```bash
mkdir -p crates/approach-viz-core/src
```

```toml
# crates/approach-viz-core/Cargo.toml
[package]
name = "approach-viz-core"
version = "0.1.0"
edition = "2021"

[features]
default = []
wasm = ["wasm-bindgen"]

[dependencies]
wasm-bindgen = { version = "0.2", optional = true }

[dev-dependencies]
# none yet

[lib]
crate-type = ["cdylib", "rlib"]
```

**Step 3: Create lib.rs with module stubs**

```rust
// crates/approach-viz-core/src/lib.rs
pub mod coords;
pub mod types;
```

Create empty module files:

```rust
// crates/approach-viz-core/src/coords.rs
// WGS84 coordinate transforms

// crates/approach-viz-core/src/types.rs
// Shared constants and decoded types
```

**Step 4: Update runtime-rs Cargo.toml to join workspace**

Add to `services/runtime-rs/Cargo.toml` under `[dependencies]`:

```toml
approach-viz-core = { path = "../../crates/approach-viz-core" }
```

**Step 5: Verify workspace compiles**

Run: `cargo check`
Expected: Clean compile with no errors.

**Step 6: Commit**

```bash
git add Cargo.toml crates/ services/runtime-rs/Cargo.toml
git commit -m "feat: scaffold approach-viz-core workspace and crate skeleton"
```

---

### Task 2: coords Module — WGS84 Projection + Earth Curvature

Port the 6 pure math functions from `app/scene/approach-path/coordinates.ts` and align with `services/runtime-rs/src/utils.rs:196-208`.

**Files:**

- Modify: `crates/approach-viz-core/src/coords.rs`
- Create: `crates/approach-viz-core/src/coords_tests.rs` (or inline `#[cfg(test)]`)

**Step 1: Write failing tests for coordinate transforms**

Add to `crates/approach-viz-core/src/coords.rs`:

```rust
// WGS84 constants (match services/runtime-rs/src/constants.rs:27-31)
const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;
const METERS_TO_NM: f64 = 1.0 / 1852.0;
const WGS84_SEMI_MAJOR_METERS: f64 = 6_378_137.0;
const WGS84_FLATTENING: f64 = 1.0 / 298.257_223_563;
const WGS84_E2: f64 = WGS84_FLATTENING * (2.0 - WGS84_FLATTENING);
const WGS84_SEMI_MINOR_METERS: f64 = WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_FLATTENING);
/// Feet-to-NM scale factor (matches ALTITUDE_SCALE in approach-path/constants.ts).
pub const ALTITUDE_SCALE: f64 = 1.0 / 6076.12;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geocentric_radius_at_equator() {
        let r = geocentric_radius_nm(0.0);
        assert!((r - 3443.92).abs() < 0.1, "equatorial radius ~3443.9 NM, got {r}");
    }

    #[test]
    fn geocentric_radius_at_pole() {
        let r = geocentric_radius_nm(90.0);
        assert!((r - 3432.37).abs() < 0.1, "polar radius ~3432.4 NM, got {r}");
    }

    #[test]
    fn lat_lon_to_local_identity_at_ref() {
        let (x, z) = lat_lon_to_local(40.0, -74.0, 40.0, -74.0);
        assert!(x.abs() < 1e-10);
        assert!(z.abs() < 1e-10);
    }

    #[test]
    fn lat_lon_to_local_one_degree_north() {
        // 1 degree north of ref should give z ~ -60 NM (negative because north is -z)
        let (x, z) = lat_lon_to_local(41.0, -74.0, 40.0, -74.0);
        assert!(x.abs() < 0.01, "x should be ~0, got {x}");
        assert!((z - (-60.0)).abs() < 1.0, "z should be ~-60 NM, got {z}");
    }

    #[test]
    fn lat_lon_to_local_one_degree_east() {
        let (x, _z) = lat_lon_to_local(40.0, -73.0, 40.0, -74.0);
        // At 40° lat, 1° lon ≈ 46.6 NM east
        assert!((x - 46.6).abs() < 1.0, "x should be ~46.6 NM, got {x}");
    }

    #[test]
    fn alt_to_y_scales_correctly() {
        // 1000 ft at scale 1.0 → 1000 / 6076.12 ≈ 0.1646 NM
        let y = alt_to_y(1000.0, 1.0);
        assert!((y - 0.1646).abs() < 0.001, "got {y}");
    }

    #[test]
    fn earth_curvature_drop_at_60nm() {
        let drop = earth_curvature_drop_nm(60.0, 0.0, 40.0);
        // 60² / (2 * ~3440) ≈ 0.523 NM ≈ 3177 ft
        assert!((drop - 0.52).abs() < 0.05, "got {drop}");
    }

    #[test]
    fn normalize_heading_wraps() {
        assert!((normalize_heading(370.0) - 10.0).abs() < 1e-10);
        assert!((normalize_heading(-10.0) - 350.0).abs() < 1e-10);
        assert!((normalize_heading(0.0)).abs() < 1e-10);
    }

    #[test]
    fn magnetic_to_true_applies_variation() {
        let true_hdg = magnetic_to_true_heading(350.0, 15.0);
        assert!((true_hdg - 5.0).abs() < 1e-10, "350 mag + 15 var = 5 true, got {true_hdg}");
    }

    #[test]
    fn magnetic_to_true_handles_nan_variation() {
        let true_hdg = magnetic_to_true_heading(90.0, f64::NAN);
        assert!((true_hdg - 90.0).abs() < 1e-10, "NaN variation treated as 0");
    }
}
```

**Step 2: Run tests — verify they fail**

Run: `cargo test -p approach-viz-core`
Expected: compile errors (functions not defined yet).

**Step 3: Implement coordinate functions**

```rust
/// Geocentric radius of the WGS84 ellipsoid at a given latitude, in NM.
pub fn geocentric_radius_nm(latitude_deg: f64) -> f64 {
    let phi = latitude_deg * DEG_TO_RAD;
    let cos_phi = phi.cos();
    let sin_phi = phi.sin();
    let a = WGS84_SEMI_MAJOR_METERS;
    let b = WGS84_SEMI_MINOR_METERS;
    let a2_cos = a * a * cos_phi;
    let b2_sin = b * b * sin_phi;
    let numerator = a2_cos * a2_cos + b2_sin * b2_sin;
    let a_cos = a * cos_phi;
    let b_sin = b * sin_phi;
    let denominator = a_cos * a_cos + b_sin * b_sin;
    (numerator / denominator).sqrt() * METERS_TO_NM
}

/// Convert lat/lon to local NM coordinates relative to a reference point.
/// Returns (x_east_nm, z_south_nm) — note z is negative-north (Three.js convention).
pub fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> (f64, f64) {
    let phi = ref_lat * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();
    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_m = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_m = (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    let d_lat_rad = (lat - ref_lat) * DEG_TO_RAD;
    let d_lon_rad = (lon - ref_lon) * DEG_TO_RAD;
    let east_nm = d_lon_rad * prime_vertical_m * cos_phi * METERS_TO_NM;
    let north_nm = d_lat_rad * meridional_m * METERS_TO_NM;

    (east_nm, -north_nm) // x = east, z = -north
}

/// Scale altitude (feet) to scene Y coordinate.
pub fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64 {
    alt_feet * ALTITUDE_SCALE * vertical_scale
}

/// Earth curvature drop in NM at a given horizontal range from the reference point.
pub fn earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64 {
    let dist = (x_nm * x_nm + z_nm * z_nm).sqrt();
    let radius = geocentric_radius_nm(ref_lat);
    (dist * dist) / (2.0 * radius)
}

/// Normalize heading to [0, 360).
pub fn normalize_heading(degrees: f64) -> f64 {
    let wrapped = degrees % 360.0;
    if wrapped < 0.0 { wrapped + 360.0 } else { wrapped }
}

/// Convert magnetic course to true heading, treating non-finite variation as 0.
pub fn magnetic_to_true_heading(magnetic_course: f64, magnetic_variation: f64) -> f64 {
    let var = if magnetic_variation.is_finite() { magnetic_variation } else { 0.0 };
    normalize_heading(magnetic_course + var)
}

/// NM-per-degree projection scales at a given latitude. Returns (east, north).
/// Equivalent to `projection_scales_nm_per_degree` in runtime-rs/src/utils.rs.
pub fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    let phi = lat_deg * DEG_TO_RAD;
    let sin_phi = phi.sin();
    let cos_phi = phi.cos();
    let denom = (1.0 - WGS84_E2 * sin_phi * sin_phi).sqrt();
    let prime_vertical_m = WGS84_SEMI_MAJOR_METERS / denom;
    let meridional_m = (WGS84_SEMI_MAJOR_METERS * (1.0 - WGS84_E2)) / (denom * denom * denom);

    (
        DEG_TO_RAD * prime_vertical_m * cos_phi * METERS_TO_NM,
        DEG_TO_RAD * meridional_m * METERS_TO_NM,
    )
}
```

**Step 4: Run tests — verify they pass**

Run: `cargo test -p approach-viz-core`
Expected: all tests PASS.

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/coords.rs
git commit -m "feat(core): implement WGS84 coordinate transforms with tests"
```

---

### Task 3: types Module — Wire Format Constants + Decoded Types

Shared constants for the AVMR and AVTR binary wire formats, plus the decoded output types that workers consume. These are the _decoded_ (client-side) types, not the server-side storage types.

**Files:**

- Modify: `crates/approach-viz-core/src/types.rs`

**Step 1: Write decoded types and wire constants**

```rust
// crates/approach-viz-core/src/types.rs

// ── MRMS wire format constants (match runtime-rs/src/constants.rs:77-86) ──
pub const MRMS_WIRE_MAGIC: [u8; 4] = *b"AVMR";
pub const MRMS_WIRE_V2_VERSION: u16 = 2;
pub const MRMS_WIRE_V3_VERSION: u16 = 3;
pub const MRMS_WIRE_HEADER_BYTES: usize = 64;
pub const MRMS_WIRE_RECORD_BYTES: usize = 20;
pub const MRMS_WIRE_DBZ_QUANT_STEP_TENTHS: i16 = 50;

// ── Traffic wire format constants (match runtime-rs/src/traffic_api.rs:40-47) ──
pub const TRAFFIC_WIRE_MAGIC: [u8; 4] = *b"AVTR";
pub const TRAFFIC_WIRE_VERSION: u16 = 1;
pub const TRAFFIC_WIRE_HEADER_BYTES: usize = 64;
pub const TRAFFIC_AIRCRAFT_RECORD_BYTES: usize = 40;
pub const TRAFFIC_HISTORY_GROUP_BYTES: usize = 16;
pub const TRAFFIC_HISTORY_POINT_BYTES: usize = 20;
pub const TRAFFIC_FLAG_HAS_ERROR: u32 = 1;

// ── Phase codes ──
pub const PHASE_RAIN: u8 = 0;
pub const PHASE_MIXED: u8 = 1;
pub const PHASE_SNOW: u8 = 2;

// ── Altitude/rendering constants ──
pub const FEET_PER_NM: f64 = 6076.12;
pub const ALTITUDE_SCALE: f64 = 1.0 / FEET_PER_NM;

// ── MRMS preprocess constants ──
pub const DECLUTTER_LOW_MAX_FEET: f64 = 10_000.0;
pub const DECLUTTER_MID_MAX_FEET: f64 = 25_000.0;
pub const CROSS_SECTION_BINS_X: usize = 120;
pub const CROSS_SECTION_BINS_Y: usize = 56;
pub const MIN_VOXEL_HEIGHT_NM: f64 = 0.015;

// ── Decoded MRMS voxel (output of wire decode) ──
/// One decoded voxel brick from the AVMR wire format.
#[derive(Debug, Clone, Copy)]
pub struct DecodedVoxel {
    pub x_nm: f32,
    pub z_nm: f32,
    pub bottom_feet: u16,
    pub top_feet: u16,
    pub dbz_tenths: i16,
    pub phase: u8,
    pub surface_phase: u8,
    pub span_x: u16,
    pub span_y: u16,
    pub span_z: u16,
    pub level_start: u8,
}

/// Decoded MRMS volume header + metadata.
#[derive(Debug, Clone)]
pub struct DecodedMrmsVolume {
    pub version: u16,
    pub voxel_count: u32,
    pub layer_count: u16,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub footprint_x_nm: f32,
    pub footprint_y_nm: f32,
    pub layer_voxel_counts: Vec<u32>,
    /// Parallel arrays (SoA layout for cache-friendly iteration)
    pub x_nm: Vec<f32>,
    pub z_nm: Vec<f32>,
    pub bottom_feet: Vec<u16>,
    pub top_feet: Vec<u16>,
    pub dbz_tenths: Vec<i16>,
    pub phase: Vec<u8>,
    pub surface_phase: Vec<u8>,
    pub footprint_x_span: Vec<u16>,
    pub footprint_y_span: Vec<u16>,
}

// ── Decoded traffic types ──
#[derive(Debug, Clone)]
pub struct DecodedTrafficAircraft {
    pub hex: String,
    pub flight: Option<String>,
    pub lat: f32,
    pub lon: f32,
    pub altitude_feet: Option<f32>,
    pub ground_speed_kt: Option<f32>,
    pub track_deg: Option<f32>,
    pub last_seen_seconds: Option<f32>,
    pub is_on_ground: bool,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficHistoryPoint {
    pub lat: f32,
    pub lon: f32,
    pub altitude_feet: f32,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficHistoryGroup {
    pub hex: String,
    pub points: Vec<DecodedTrafficHistoryPoint>,
}

#[derive(Debug, Clone)]
pub struct DecodedTrafficPayload {
    pub aircraft: Vec<DecodedTrafficAircraft>,
    pub history_groups: Vec<DecodedTrafficHistoryGroup>,
    pub fetched_at_ms: i64,
    pub source: Option<String>,
    pub error: Option<String>,
}

// ── Phase mode / declutter mode (mirror TS enums) ──
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseMode {
    Altitude,
    Surface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclutterMode {
    All,
    Low,
    Mid,
    High,
}

// ── Prepared volume output (mirror NexradPreparedVolumeData) ──
#[derive(Debug, Clone)]
pub struct PreparedVolume {
    pub valid_count: usize,
    pub valid_indices: Vec<i32>,
    pub y_base: Vec<f32>,
    pub height_base: Vec<f32>,
    pub corrected_bottom_feet: Vec<f32>,
    pub corrected_top_feet: Vec<f32>,
    pub effective_phase_code: Vec<u8>,
    pub declutter_indices: Vec<i32>,
    pub declutter_count: usize,
}

// ── Cross-section output ──
#[derive(Debug, Clone)]
pub struct CrossSectionData {
    pub bins_x: usize,
    pub bins_y: usize,
    pub grid: Vec<f32>,
    pub phase_grid: Vec<i8>,
    pub top_envelope_feet: Vec<f32>,
    pub max_top_feet: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_constants_match_runtime() {
        assert_eq!(MRMS_WIRE_MAGIC, *b"AVMR");
        assert_eq!(TRAFFIC_WIRE_MAGIC, *b"AVTR");
        assert_eq!(MRMS_WIRE_HEADER_BYTES, 64);
        assert_eq!(TRAFFIC_WIRE_HEADER_BYTES, 64);
    }

    #[test]
    fn altitude_scale_consistent() {
        assert!((ALTITUDE_SCALE - 1.0 / 6076.12).abs() < 1e-12);
        assert!((FEET_PER_NM * ALTITUDE_SCALE - 1.0).abs() < 1e-10);
    }
}
```

**Step 2: Run tests**

Run: `cargo test -p approach-viz-core`
Expected: PASS.

**Step 3: Commit**

```bash
git add crates/approach-viz-core/src/types.rs
git commit -m "feat(core): add wire format constants and decoded types"
```

---

## Phase 2: Wire Format Decoders

### Task 4: mrms_wire_codec — AVMR Binary Decode

Port `app/scene/nexrad/nexrad-decode.ts:32-146` (`decodeBinaryPayload`) to Rust.

**Files:**

- Create: `crates/approach-viz-core/src/mrms_wire_codec.rs`
- Modify: `crates/approach-viz-core/src/lib.rs` (add module)

**Step 1: Write failing tests with synthetic AVMR payloads**

Build a test that constructs a minimal valid AVMR binary payload (header + 1 voxel) and decodes it.

```rust
// crates/approach-viz-core/src/mrms_wire_codec.rs

use crate::types::*;

/// Decode error type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MrmsDecodeError {
    TooShort { needed: usize, got: usize },
    BadMagic([u8; 4]),
    UnsupportedVersion(u16),
    VoxelOverflow { claimed: u32, available: usize },
}

impl std::fmt::Display for MrmsDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort { needed, got } => write!(f, "payload too short: need {needed}, got {got}"),
            Self::BadMagic(m) => write!(f, "bad magic: {:?}", m),
            Self::UnsupportedVersion(v) => write!(f, "unsupported version: {v}"),
            Self::VoxelOverflow { claimed, available } => {
                write!(f, "claimed {claimed} voxels but only {available} bytes available")
            }
        }
    }
}

pub fn decode_mrms_binary(data: &[u8]) -> Result<DecodedMrmsVolume, MrmsDecodeError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid AVMR V3 payload with the given voxels.
    fn build_test_payload(voxels: &[DecodedVoxel], layer_count: u16) -> Vec<u8> {
        let layer_counts_bytes = (layer_count as usize) * 4;
        let voxel_bytes = voxels.len() * MRMS_WIRE_RECORD_BYTES;
        let total = MRMS_WIRE_HEADER_BYTES + layer_counts_bytes + voxel_bytes;
        let mut buf = vec![0u8; total];

        // Header
        buf[0..4].copy_from_slice(b"AVMR");
        buf[4..6].copy_from_slice(&MRMS_WIRE_V3_VERSION.to_le_bytes());
        buf[6..8].copy_from_slice(&64u16.to_le_bytes());
        buf[12..16].copy_from_slice(&(voxels.len() as u32).to_le_bytes());
        buf[16..18].copy_from_slice(&layer_count.to_le_bytes());
        buf[18..20].copy_from_slice(&(MRMS_WIRE_RECORD_BYTES as u16).to_le_bytes());
        buf[20..28].copy_from_slice(&1000i64.to_le_bytes()); // generated_at_ms
        buf[28..36].copy_from_slice(&2000i64.to_le_bytes()); // scan_time_ms
        buf[36..38].copy_from_slice(&50u16.to_le_bytes()); // footprint_x (0.050 NM)
        buf[38..40].copy_from_slice(&50u16.to_le_bytes()); // footprint_y

        // Layer counts (all voxels in layer 0 for simplicity)
        let lc_start = MRMS_WIRE_HEADER_BYTES;
        if layer_count > 0 {
            buf[lc_start..lc_start + 4].copy_from_slice(&(voxels.len() as u32).to_le_bytes());
        }

        // Voxel records
        let vox_start = lc_start + layer_counts_bytes;
        for (i, v) in voxels.iter().enumerate() {
            let off = vox_start + i * MRMS_WIRE_RECORD_BYTES;
            buf[off..off + 2].copy_from_slice(&(v.x_nm * 100.0) as i16).to_le_bytes()); // x * 100
            // ... (encoding matches wire.rs layout)
        }
        // Simplified: full encode helper in implementation
        buf
    }

    #[test]
    fn decode_empty_payload() {
        let buf = build_test_payload(&[], 1);
        let vol = decode_mrms_binary(&buf).unwrap();
        assert_eq!(vol.voxel_count, 0);
        assert_eq!(vol.layer_count, 1);
        assert_eq!(vol.generated_at_ms, 1000);
    }

    #[test]
    fn reject_bad_magic() {
        let mut buf = vec![0u8; 128];
        buf[0..4].copy_from_slice(b"XXXX");
        assert!(matches!(
            decode_mrms_binary(&buf),
            Err(MrmsDecodeError::BadMagic(_))
        ));
    }

    #[test]
    fn reject_truncated() {
        assert!(matches!(
            decode_mrms_binary(&[0u8; 10]),
            Err(MrmsDecodeError::TooShort { .. })
        ));
    }

    #[test]
    fn decode_single_voxel_round_trip() {
        // Build a 1-voxel, 1-layer AVMR payload manually
        let layer_count: u16 = 1;
        let total = MRMS_WIRE_HEADER_BYTES + 4 + MRMS_WIRE_RECORD_BYTES;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(b"AVMR");
        buf[4..6].copy_from_slice(&MRMS_WIRE_V3_VERSION.to_le_bytes());
        buf[6..8].copy_from_slice(&64u16.to_le_bytes());
        buf[12..16].copy_from_slice(&1u32.to_le_bytes()); // 1 voxel
        buf[16..18].copy_from_slice(&layer_count.to_le_bytes());
        buf[18..20].copy_from_slice(&20u16.to_le_bytes());
        buf[20..28].copy_from_slice(&5000i64.to_le_bytes());
        buf[28..36].copy_from_slice(&6000i64.to_le_bytes());
        buf[36..38].copy_from_slice(&100u16.to_le_bytes()); // 0.100 NM footprint
        buf[38..40].copy_from_slice(&100u16.to_le_bytes());

        // Layer counts
        let lc = MRMS_WIRE_HEADER_BYTES;
        buf[lc..lc + 4].copy_from_slice(&1u32.to_le_bytes());

        // Voxel record at offset 68
        let v = MRMS_WIRE_HEADER_BYTES + 4;
        buf[v..v + 2].copy_from_slice(&500i16.to_le_bytes());   // x: 5.00 NM
        buf[v + 2..v + 4].copy_from_slice(&(-300i16).to_le_bytes()); // z: -3.00 NM
        buf[v + 4..v + 6].copy_from_slice(&5000u16.to_le_bytes());  // bottom: 5000 ft
        buf[v + 6..v + 8].copy_from_slice(&10000u16.to_le_bytes()); // top: 10000 ft
        buf[v + 8..v + 10].copy_from_slice(&350i16.to_le_bytes());  // 35.0 dBZ
        buf[v + 10] = PHASE_RAIN;          // phase
        buf[v + 11] = 0;                   // level_start
        buf[v + 12..v + 14].copy_from_slice(&1u16.to_le_bytes()); // span_x
        buf[v + 14..v + 16].copy_from_slice(&1u16.to_le_bytes()); // span_y
        buf[v + 16..v + 18].copy_from_slice(&1u16.to_le_bytes()); // span_z
        buf[v + 18] = PHASE_SNOW;          // surface_phase (V3)
        buf[v + 19] = 0;                   // reserved

        let vol = decode_mrms_binary(&buf).unwrap();
        assert_eq!(vol.voxel_count, 1);
        assert_eq!(vol.x_nm.len(), 1);
        assert!((vol.x_nm[0] - 5.0).abs() < 0.01);
        assert!((vol.z_nm[0] - (-3.0)).abs() < 0.01);
        assert_eq!(vol.bottom_feet[0], 5000);
        assert_eq!(vol.top_feet[0], 10000);
        assert_eq!(vol.dbz_tenths[0], 350);
        assert_eq!(vol.phase[0], PHASE_RAIN);
        assert_eq!(vol.surface_phase[0], PHASE_SNOW);
        assert_eq!(vol.generated_at_ms, 5000);
        assert!((vol.footprint_x_nm - 0.100).abs() < 0.001);
    }
}
```

**Step 2: Run tests — verify compile error**

Run: `cargo test -p approach-viz-core`
Expected: compile error on `todo!()`.

**Step 3: Implement decode_mrms_binary**

Read LE integers from byte slices using inline helpers (avoid external dep for simple reads):

```rust
fn read_u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}
fn read_i16_le(data: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes([data[offset], data[offset + 1]])
}
fn read_u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}
fn read_i64_le(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

pub fn decode_mrms_binary(data: &[u8]) -> Result<DecodedMrmsVolume, MrmsDecodeError> {
    if data.len() < MRMS_WIRE_HEADER_BYTES {
        return Err(MrmsDecodeError::TooShort {
            needed: MRMS_WIRE_HEADER_BYTES,
            got: data.len(),
        });
    }

    let magic: [u8; 4] = data[0..4].try_into().unwrap();
    if magic != MRMS_WIRE_MAGIC {
        return Err(MrmsDecodeError::BadMagic(magic));
    }

    let version = read_u16_le(data, 4);
    if version != MRMS_WIRE_V2_VERSION && version != MRMS_WIRE_V3_VERSION {
        return Err(MrmsDecodeError::UnsupportedVersion(version));
    }

    let voxel_count = read_u32_le(data, 12);
    let layer_count = read_u16_le(data, 16);
    let record_bytes = read_u16_le(data, 18) as usize;
    let generated_at_ms = read_i64_le(data, 20);
    let scan_time_ms = read_i64_le(data, 28);
    let footprint_x_mm = read_u16_le(data, 36);
    let footprint_y_mm = read_u16_le(data, 38);

    let layer_counts_start = MRMS_WIRE_HEADER_BYTES;
    let layer_counts_bytes = (layer_count as usize) * 4;
    let voxels_start = layer_counts_start + layer_counts_bytes;
    let record_size = if record_bytes > 0 { record_bytes } else { MRMS_WIRE_RECORD_BYTES };

    let needed = voxels_start + (voxel_count as usize) * record_size;
    if data.len() < needed {
        return Err(MrmsDecodeError::VoxelOverflow {
            claimed: voxel_count,
            available: data.len().saturating_sub(voxels_start),
        });
    }

    // Layer counts
    let mut layer_voxel_counts = Vec::with_capacity(layer_count as usize);
    for i in 0..layer_count as usize {
        layer_voxel_counts.push(read_u32_le(data, layer_counts_start + i * 4));
    }

    // Decode voxels into SoA arrays
    let n = voxel_count as usize;
    let mut x_nm = Vec::with_capacity(n);
    let mut z_nm = Vec::with_capacity(n);
    let mut bottom_feet = Vec::with_capacity(n);
    let mut top_feet = Vec::with_capacity(n);
    let mut dbz_tenths = Vec::with_capacity(n);
    let mut phase = Vec::with_capacity(n);
    let mut surface_phase = Vec::with_capacity(n);
    let mut footprint_x_span = Vec::with_capacity(n);
    let mut footprint_y_span = Vec::with_capacity(n);

    for i in 0..n {
        let off = voxels_start + i * record_size;
        x_nm.push(read_i16_le(data, off) as f32 / 100.0);
        z_nm.push(read_i16_le(data, off + 2) as f32 / 100.0);
        bottom_feet.push(read_u16_le(data, off + 4));
        top_feet.push(read_u16_le(data, off + 6));
        dbz_tenths.push(read_i16_le(data, off + 8));
        phase.push(data[off + 10]);
        surface_phase.push(if version >= MRMS_WIRE_V3_VERSION { data[off + 18] } else { data[off + 10] });
        footprint_x_span.push(read_u16_le(data, off + 12));
        footprint_y_span.push(read_u16_le(data, off + 14));
    }

    Ok(DecodedMrmsVolume {
        version,
        voxel_count,
        layer_count,
        generated_at_ms,
        scan_time_ms,
        footprint_x_nm: footprint_x_mm as f32 / 1000.0,
        footprint_y_nm: footprint_y_mm as f32 / 1000.0,
        layer_voxel_counts,
        x_nm,
        z_nm,
        bottom_feet,
        top_feet,
        dbz_tenths,
        phase,
        surface_phase,
        footprint_x_span,
        footprint_y_span,
    })
}
```

**Step 4: Run tests — verify they pass**

Run: `cargo test -p approach-viz-core`
Expected: PASS.

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/mrms_wire_codec.rs crates/approach-viz-core/src/lib.rs
git commit -m "feat(core): AVMR binary wire format decoder with round-trip tests"
```

---

### Task 5: traffic_codec — AVTR Binary Decode

Port the client-side AVTR binary decode (currently in `app/scene/traffic/traffic-binary-protocol.ts`).

**Files:**

- Create: `crates/approach-viz-core/src/traffic_codec.rs`
- Modify: `crates/approach-viz-core/src/lib.rs`

**Step 1: Write failing tests**

Follow the same pattern as Task 4: construct a minimal AVTR payload (header + 1 aircraft + 1 history group + 1 history point + string table), decode, verify fields.

Key assertions:

- Bad magic → `TrafficDecodeError::BadMagic`
- Truncated → `TrafficDecodeError::TooShort`
- Single aircraft with known lat/lon/alt round-trips correctly
- History group + points associate correctly by hex
- NaN altitude → `None`
- `is_on_ground` flag bit 0 decodes correctly
- Error string in header → `payload.error == Some("...")`

**Step 2: Run tests — verify compile error**

Run: `cargo test -p approach-viz-core`

**Step 3: Implement decode_traffic_binary**

Same LE read helpers. Parse 64-byte header, then aircraft records (40B each), history groups (16B), history points (20B), and string table. Return `DecodedTrafficPayload`.

Key details:

- f32 fields: use `f32::from_le_bytes`. NaN check: `if v.is_nan() { None } else { Some(v) }`
- String table: byte offsets + lengths into the trailing string pool, decoded as UTF-8
- `is_on_ground`: `(flags & 1) != 0`

**Step 4: Run tests — verify pass**

Run: `cargo test -p approach-viz-core`

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/traffic_codec.rs crates/approach-viz-core/src/lib.rs
git commit -m "feat(core): AVTR traffic binary decoder with round-trip tests"
```

---

## Phase 3: Compute Kernels

### Task 6: mrms_preprocess — Volume Filter + Curvature + Cross-Section

Port `app/scene/nexrad/nexrad-preprocess.ts` functions: `prepareVolumeData`, `buildCrossSectionData`, `prepareEchoTopSurfaces`.

**Files:**

- Create: `crates/approach-viz-core/src/mrms_preprocess.rs`
- Modify: `crates/approach-viz-core/src/lib.rs`

**Step 1: Write failing tests**

Test cases:

- `prepare_volume_empty` → zero voxels in, zero out
- `prepare_volume_filters_below_min_dbz` → voxel with 20 dBZ tenths filtered when min is 50
- `prepare_volume_keeps_above_min_dbz` → voxel with 350 tenths kept
- `prepare_volume_earth_curvature_correction` → verify corrected bottom/top decrease with distance
- `prepare_volume_phase_mode_surface` → picks `surface_phase` field
- `prepare_volume_phase_mode_altitude` → picks `phase` field
- `prepare_volume_declutter_low` → filters out voxels above 10k ft center
- `build_cross_section_basic` → 3 voxels along slice axis, verify grid bins populated
- `build_cross_section_empty` → no valid voxels → None
- `prepare_echo_tops_basic` → cells with known top heights → correct y_base scaling

**Step 2: Run tests — verify compile error**

**Step 3: Implement functions**

Port the logic from `nexrad-preprocess.ts` line-for-line. Key differences from TS:

- Use `DecodedMrmsVolume` (SoA arrays) instead of `NexradVolumePayload`
- Return `PreparedVolume` and `CrossSectionData` from `types.rs`
- Earth curvature via `coords::earth_curvature_drop_nm`
- `ALTITUDE_SCALE` from `types.rs`
- `f32::is_finite()` for validation (same semantics as `Number.isFinite`)

The cross-section function takes `slice_axis: (f64, f64)` and `slice_perp_axis: (f64, f64)` for the dot-product projection.

**Step 4: Run tests — verify pass**

Run: `cargo test -p approach-viz-core`

**Step 5: Commit**

```bash
git add crates/approach-viz-core/src/mrms_preprocess.rs crates/approach-viz-core/src/lib.rs
git commit -m "feat(core): MRMS volume preprocess, cross-section, echo-top prep"
```

---

### Task 7: traffic_merge — Track Merge/Prune/Projection + FNV Hash

Port the stateful traffic merge logic from `app/scene/traffic/traffic.worker.ts`. This is the most complex module — it maintains a `HashMap<String, TrafficTrack>` state.

**Files:**

- Create: `crates/approach-viz-core/src/traffic_merge.rs`
- Modify: `crates/approach-viz-core/src/lib.rs`

**Step 1: Write failing tests**

Test cases:

- `merge_single_aircraft` → one aircraft, no history, creates track
- `merge_updates_existing_track` → same hex, new position, track updated
- `merge_prunes_stale_tracks` → track older than cutoff removed
- `merge_history_dedup` → duplicate timestamps collapsed
- `merge_history_sorted` → out-of-order history sorted by timestamp
- `sample_distance_filtering` → points closer than 0.03 NM skipped
- `altitude_delta_filtering` → points with <100 ft altitude change and close distance skipped
- `to_scene_point_basic` → known lat/lon/alt → expected (x, y, z) tuple
- `to_scene_point_earth_curvature` → curvature compensation lowers y
- `render_hash_deterministic` → same input → same FNV hash
- `render_hash_changes_on_mutation` → different input → different hash
- `prune_on_error` → trims history, removes empty tracks
- `hide_ground_targets` → ground tracks removed when flag set

**Step 2: Implement types and logic**

```rust
use std::collections::HashMap;
use crate::coords::{lat_lon_to_local, alt_to_y, earth_curvature_drop_nm};

const MIN_SAMPLE_DISTANCE_NM: f64 = 0.03;
const MIN_SAMPLE_ALTITUDE_DELTA_FEET: f64 = 100.0;
const STALE_GRACE_MS: i64 = 20_000;

pub struct TrafficHistoryPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub timestamp_ms: i64,
}

pub struct TrafficTrack {
    pub hex: String,
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub flight: Option<String>,
    pub is_on_ground: bool,
    pub last_update_ms: i64,
    pub history: Vec<TrafficHistoryPoint>,
}

pub struct TrafficState {
    tracks: HashMap<String, TrafficTrack>,
}

/// Render-ready output point.
pub struct ScenePoint {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}
```

The `TrafficState` struct encapsulates the mutable track map. Methods:

- `merge(&mut self, aircraft, now_ms, history_minutes, hide_ground, backfill_history)`
- `prune_for_error(&mut self, now_ms, history_minutes)`
- `recompute(&mut self, now_ms, history_minutes, hide_ground)`
- `build_render_tracks(&self, ref_lat, ref_lon, airports, vertical_scale, earth_curvature) -> (Vec<RenderTrack>, u64)` (tracks + hash)

FNV-1a hash (port from `traffic.worker.ts:22-63`):

```rust
const FNV_OFFSET: u32 = 2166136261;

fn fnv_hash_u32(hash: u32, value: u32) -> u32 {
    (hash ^ value).wrapping_mul(16777619)
}
```

**Step 3: Run tests — verify pass**

Run: `cargo test -p approach-viz-core`

**Step 4: Commit**

```bash
git add crates/approach-viz-core/src/traffic_merge.rs crates/approach-viz-core/src/lib.rs
git commit -m "feat(core): traffic merge/prune/projection with FNV hashing"
```

---

## Phase 4: WASM Bindings + Worker Integration

### Task 8: WASM Bindings via wasm-bindgen

Expose core functions to JavaScript workers through `wasm-bindgen`.

**Files:**

- Create: `crates/approach-viz-core/src/wasm.rs`
- Modify: `crates/approach-viz-core/src/lib.rs`
- Modify: `crates/approach-viz-core/Cargo.toml`

**Step 1: Add wasm-bindgen feature-gated module**

In `lib.rs`:

```rust
#[cfg(feature = "wasm")]
pub mod wasm;
```

In `wasm.rs`, expose thin wrappers that accept/return `js_sys` typed arrays and `JsValue`:

```rust
use wasm_bindgen::prelude::*;
use js_sys::{Float32Array, Int32Array, Uint8Array, Int16Array};

/// Decode AVMR binary payload, returning JS object with SoA typed arrays.
#[wasm_bindgen]
pub fn decode_mrms_volume(data: &[u8]) -> Result<JsValue, JsValue> {
    let vol = crate::mrms_wire_codec::decode_mrms_binary(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    // Build JS object with typed array views
    // ...
}

/// Decode AVTR binary payload.
#[wasm_bindgen]
pub fn decode_traffic(data: &[u8]) -> Result<JsValue, JsValue> {
    // ...
}

/// Prepare MRMS volume for rendering — filter, curvature, phase, declutter.
#[wasm_bindgen]
pub fn prepare_mrms_volume(
    // SoA input arrays as typed array refs + scalar params
) -> Result<JsValue, JsValue> {
    // ...
}

/// Convert lat/lon to local scene coordinates.
#[wasm_bindgen]
pub fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> Box<[f64]> {
    let (x, z) = crate::coords::lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    Box::new([x, z])
}
```

**Step 2: Build WASM**

```bash
# Install wasm-pack if not present
cargo install wasm-pack

# Build with web target (for manual init in workers)
wasm-pack build crates/approach-viz-core --target web --out-dir ../../packages/approach-viz-core-wasm -- --features wasm
```

**Step 3: Verify WASM output exists**

```bash
ls packages/approach-viz-core-wasm/
```

Expected: `approach_viz_core.js`, `approach_viz_core_bg.wasm`, `package.json`, etc.

**Step 4: Commit**

```bash
git add crates/approach-viz-core/src/wasm.rs packages/approach-viz-core-wasm/
git commit -m "feat(core): wasm-bindgen bindings for workers"
```

---

### Task 9: Worker Integration — Replace TS Compute with WASM

Wire existing workers to call WASM instead of TypeScript for decode and preprocess.

**Files:**

- Modify: `app/scene/nexrad/nexrad.worker.ts` (import + call WASM decode/preprocess)
- Modify: `app/scene/traffic/traffic.worker.ts` (import + call WASM decode)
- Modify: `next.config.ts` (WASM loading support if needed)
- Modify: `package.json` (add wasm-pack build script)

**Step 1: Add npm build script**

In `package.json`, add:

```json
"build:wasm": "wasm-pack build crates/approach-viz-core --target web --out-dir ../../packages/approach-viz-core-wasm -- --features wasm"
```

**Step 2: Initialize WASM in worker**

In `nexrad.worker.ts`, add at top level:

```typescript
import init, {
  decode_mrms_volume,
  prepare_mrms_volume
} from '../../../packages/approach-viz-core-wasm';

let wasmReady: Promise<void> | null = null;
function ensureWasm() {
  if (!wasmReady) {
    wasmReady = init();
  }
  return wasmReady;
}
```

Before processing messages, `await ensureWasm()`.

**Step 3: Replace decodeBinaryPayload call with WASM**

In the worker's poll handler, replace:

```typescript
// Before:
const decoded = decodeBinaryPayload(buffer);
// After:
const decoded = decode_mrms_volume(new Uint8Array(buffer));
```

**Step 4: Replace prepareVolumeData call with WASM**

Similar replacement — pass SoA arrays to WASM, receive prepared volume back.

**Step 5: Run existing MRMS tests**

Run: `npm run test:mrms`
Expected: PASS (WASM produces identical output to TS).

**Step 6: Repeat for traffic worker**

Replace `decodeTrafficBinaryPayload` with WASM `decode_traffic`.

**Step 7: Run full test suite**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all PASS.

**Step 8: Commit**

```bash
git add app/scene/nexrad/nexrad.worker.ts app/scene/traffic/traffic.worker.ts package.json next.config.ts
git commit -m "feat: wire WASM core into nexrad + traffic workers"
```

---

## Phase 5: Runtime-rs Integration (Optional, deduplication)

### Task 10: Use Core Crate in runtime-rs

Replace duplicated math in `services/runtime-rs/src/utils.rs` with `approach-viz-core` imports.

**Files:**

- Modify: `services/runtime-rs/src/utils.rs` (replace `projection_scales_nm_per_degree` + WGS84 math)
- Modify: `services/runtime-rs/src/constants.rs` (remove duplicated WGS84 constants)
- Modify: `services/runtime-rs/src/api/wire.rs` (use core wire constants)

**Step 1: Replace projection_scales_nm_per_degree**

In `utils.rs`, replace the function body:

```rust
pub fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    approach_viz_core::coords::projection_scales_nm_per_degree(lat_deg)
}
```

Or remove the wrapper entirely and update call sites to use `approach_viz_core::coords::` directly.

**Step 2: Replace duplicated constants**

In files that use `WIRE_MAGIC`, `WIRE_V3_VERSION`, etc. — import from `approach_viz_core::types` instead.

**Step 3: Run Rust tests**

Run: `cargo test --workspace`
Expected: all tests pass across both crates.

**Step 4: Commit**

```bash
git add services/runtime-rs/
git commit -m "refactor(runtime): use approach-viz-core for shared math and constants"
```

---

## Summary

| Phase              | Tasks | Estimated Modules              | Key Risk                                                                       |
| ------------------ | ----- | ------------------------------ | ------------------------------------------------------------------------------ |
| 1. Foundation      | 1-3   | workspace, coords, types       | Workspace setup cleanly with existing runtime-rs `.cargo/config.toml`          |
| 2. Wire Decoders   | 4-5   | mrms_wire_codec, traffic_codec | Byte-level fidelity with existing TS decoders                                  |
| 3. Compute Kernels | 6-7   | mrms_preprocess, traffic_merge | Numerical parity with TS (f64 vs f32 edge cases)                               |
| 4. WASM Bindings   | 8-9   | wasm.rs, worker integration    | WASM loading in Next.js module workers; typed array boundary crossing overhead |
| 5. Runtime Dedup   | 10    | runtime-rs refactor            | Low risk, straightforward import replacement                                   |

**Validation approach:** For each module, construct test payloads in Rust that mirror known TS inputs, and assert identical outputs. When WASM is wired in (Phase 4), the existing `npm run test:mrms` suite validates end-to-end parity.

**iOS path:** After Phase 3, `approach-viz-core` compiles as a `staticlib` for `aarch64-apple-ios`. Swift calls it via C FFI or `uniffi`. No changes needed to the crate — just an additional Cargo build target.
