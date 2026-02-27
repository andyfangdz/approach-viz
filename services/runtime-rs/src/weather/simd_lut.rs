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
