/// Synthetic MRMS-like grid data for benchmarks.
///
/// Produces deterministic data matching real MRMS CONUS dimensions (3500x3500)
/// using a minimal inline PRNG -- no external `rand` dependency required.

pub struct SyntheticGrid {
    pub nx: u32,
    pub ny: u32,
    /// Length nx*ny. ~30% of values >= STORE_MIN_DBZ_TENTHS (50).
    pub dbz_tenths: Vec<i16>,
    /// Length nx*ny. ~90% finite values in [-2.0, 3.0], 10% NaN.
    pub zdr_values: Vec<f32>,
    /// Length nx*ny. ~90% finite values in [0.85, 1.01], 10% NaN.
    pub rhohv_values: Vec<f32>,
    /// Seven auxiliary flat f32 arrays, each length nx*ny.
    /// ~80% finite, 20% NaN. See field docs below.
    ///
    /// [0] precip_flag   -- discrete {0.0, 1.0, 3.0, 7.0}
    /// [1] freezing_level -- meters [2000.0, 5000.0]
    /// [2] wet_bulb_temp  -- Celsius [-5.0, 5.0]
    /// [3] surface_temp   -- Celsius [-2.0, 4.0]
    /// [4] bright_band_top    -- meters [3000.0, 5000.0]
    /// [5] bright_band_bottom -- meters [2500.0, 4500.0]
    /// [6] rqi            -- [0.0, 1.0]
    pub aux_values: [Vec<f32>; 7],
}

// ---------------------------------------------------------------------------
// Minimal seeded PRNG (LCG, Knuth constants)
// ---------------------------------------------------------------------------

struct SimpleRng(u64);

impl SimpleRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1);
        self.0
    }

    /// Returns a value in [0.0, 1.0).
    fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Returns `true` with the given probability (0.0 = never, 1.0 = always).
    fn next_bool(&mut self, probability: f32) -> bool {
        self.next_f32() < probability
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Linearly interpolate between `lo` and `hi` using `t` in [0, 1).
fn lerp(lo: f32, hi: f32, t: f32) -> f32 {
    lo + (hi - lo) * t
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Generate a deterministic synthetic grid of the given dimensions.
///
/// For MRMS CONUS use `generate_grid(3500, 3500)`.
pub fn generate_grid(nx: u32, ny: u32) -> SyntheticGrid {
    let n = (nx as usize) * (ny as usize);
    let mut rng = SimpleRng::new(0xDEAD_BEEF_CAFE_1234);

    // -- dbz_tenths: ~30% above threshold (50), rest below ----------------
    let mut dbz_tenths = Vec::with_capacity(n);
    for _ in 0..n {
        if rng.next_bool(0.30) {
            // Above threshold: [50, 700]
            let v = 50 + (rng.next_f32() * 651.0) as i16; // 50..=700
            dbz_tenths.push(v);
        } else {
            // Below threshold: [-320, 49]
            let v = -320 + (rng.next_f32() * 370.0) as i16; // -320..=49
            dbz_tenths.push(v);
        }
    }

    // -- zdr: 90% finite in [-2.0, 3.0], 10% NaN --------------------------
    let mut zdr_values = Vec::with_capacity(n);
    for _ in 0..n {
        if rng.next_bool(0.90) {
            zdr_values.push(lerp(-2.0, 3.0, rng.next_f32()));
        } else {
            zdr_values.push(f32::NAN);
        }
    }

    // -- rhohv: 90% finite in [0.85, 1.01], 10% NaN -----------------------
    let mut rhohv_values = Vec::with_capacity(n);
    for _ in 0..n {
        if rng.next_bool(0.90) {
            rhohv_values.push(lerp(0.85, 1.01, rng.next_f32()));
        } else {
            rhohv_values.push(f32::NAN);
        }
    }

    // -- aux fields: 80% finite, 20% NaN ----------------------------------
    let precip_flag_choices: [f32; 4] = [0.0, 1.0, 3.0, 7.0];

    let aux_values = std::array::from_fn(|field_idx| {
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            if rng.next_bool(0.80) {
                let val = match field_idx {
                    0 => {
                        // precip_flag -- discrete set
                        let pick = (rng.next_f32() * 4.0) as usize;
                        precip_flag_choices[pick.min(3)]
                    }
                    1 => lerp(2000.0, 5000.0, rng.next_f32()), // freezing_level
                    2 => lerp(-5.0, 5.0, rng.next_f32()),       // wet_bulb_temp
                    3 => lerp(-2.0, 4.0, rng.next_f32()),       // surface_temp
                    4 => lerp(3000.0, 5000.0, rng.next_f32()),  // bright_band_top
                    5 => lerp(2500.0, 4500.0, rng.next_f32()),  // bright_band_bottom
                    6 => rng.next_f32(),                         // rqi [0, 1)
                    _ => unreachable!(),
                };
                v.push(val);
            } else {
                v.push(f32::NAN);
            }
        }
        v
    });

    SyntheticGrid {
        nx,
        ny,
        dbz_tenths,
        zdr_values,
        rhohv_values,
        aux_values,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_output() {
        let a = generate_grid(100, 100);
        let b = generate_grid(100, 100);
        assert_eq!(a.dbz_tenths, b.dbz_tenths);
        assert_eq!(a.zdr_values.len(), b.zdr_values.len());
        // NaN != NaN in IEEE754, so compare bit patterns
        for (x, y) in a.zdr_values.iter().zip(b.zdr_values.iter()) {
            assert_eq!(x.to_bits(), y.to_bits());
        }
    }

    #[test]
    fn correct_dimensions() {
        let g = generate_grid(100, 100);
        assert_eq!(g.dbz_tenths.len(), 10_000);
        assert_eq!(g.zdr_values.len(), 10_000);
        assert_eq!(g.rhohv_values.len(), 10_000);
        for aux in &g.aux_values {
            assert_eq!(aux.len(), 10_000);
        }
    }

    #[test]
    fn approximate_fill_rates() {
        let g = generate_grid(1000, 1000);
        let n = 1_000_000usize;

        let above = g.dbz_tenths.iter().filter(|&&v| v >= 50).count();
        let ratio = above as f64 / n as f64;
        assert!(ratio > 0.25 && ratio < 0.35, "dbz above-threshold ratio: {ratio}");

        let finite_zdr = g.zdr_values.iter().filter(|v| v.is_finite()).count();
        let ratio = finite_zdr as f64 / n as f64;
        assert!(ratio > 0.85 && ratio < 0.95, "zdr finite ratio: {ratio}");

        let finite_aux0 = g.aux_values[0].iter().filter(|v| v.is_finite()).count();
        let ratio = finite_aux0 as f64 / n as f64;
        assert!(ratio > 0.75 && ratio < 0.85, "aux[0] finite ratio: {ratio}");
    }
}
