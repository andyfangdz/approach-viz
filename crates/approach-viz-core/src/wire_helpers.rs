// Shared little-endian read helpers for wire-format decoders.
//
// Used by both `mrms_wire_codec` and `traffic_codec`.

#[inline]
pub fn read_u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

#[inline]
pub fn read_u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
}

#[inline]
pub fn read_f32_le(data: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
}

#[inline]
pub fn read_i64_le(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ])
}

/// Try to reinterpret `&data[offset..offset + count * size_of::<T>()]` as `&[T]` via bytemuck.
/// Returns `Some(&[T])` when alignment is satisfied, `None` otherwise.
#[inline]
pub fn try_cast_column<T: bytemuck::Pod>(data: &[u8], offset: usize, count: usize) -> Option<&[T]> {
    let size = std::mem::size_of::<T>();
    let slice = &data[offset..offset + count * size];
    bytemuck::try_cast_slice(slice).ok()
}

/// Read a contiguous SoA column as `Vec<T>`.
/// Uses zero-copy `try_cast_slice` when alignment permits, otherwise falls back to
/// per-element reads.
#[inline]
pub fn bulk_read_column<T: bytemuck::Pod>(data: &[u8], offset: usize, count: usize) -> Vec<T> {
    match try_cast_column::<T>(data, offset, count) {
        Some(slice) => slice.to_vec(),
        None => {
            let size = std::mem::size_of::<T>();
            (0..count)
                .map(|i| {
                    let start = offset + i * size;
                    let mut val = T::zeroed();
                    bytemuck::bytes_of_mut(&mut val)
                        .copy_from_slice(&data[start..start + size]);
                    val
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_read_f32_aligned() {
        // Vec<u8> is at least 4-byte aligned, so f32 cast should succeed
        let values: Vec<f32> = vec![1.0, 2.5, -3.75, 0.0];
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let result = bulk_read_column::<f32>(&bytes, 0, 4);
        assert_eq!(result, values);
    }

    #[test]
    fn bulk_read_u16_aligned() {
        let values: Vec<u16> = vec![100, 200, 65535, 0];
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let result = bulk_read_column::<u16>(&bytes, 0, 4);
        assert_eq!(result, values);
    }

    #[test]
    fn bulk_read_i16_aligned() {
        let values: Vec<i16> = vec![-500, 300, 0, i16::MAX];
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let result = bulk_read_column::<i16>(&bytes, 0, 4);
        assert_eq!(result, values);
    }

    #[test]
    fn bulk_read_misaligned_fallback() {
        // Deliberately misalign: prepend 1 byte so f32 data starts at odd offset
        let values: Vec<f32> = vec![1.0, 2.0];
        let mut bytes = vec![0xFFu8]; // 1-byte prefix for misalignment
        bytes.extend(values.iter().flat_map(|v| v.to_le_bytes()));
        let result = bulk_read_column::<f32>(&bytes, 1, 2);
        assert_eq!(result, values);
    }

    #[test]
    fn bulk_read_empty() {
        let data = vec![0u8; 64];
        let result = bulk_read_column::<f32>(&data, 0, 0);
        assert!(result.is_empty());
    }

    #[test]
    fn try_cast_column_returns_none_on_misalign() {
        let values: Vec<u32> = vec![42, 99];
        let mut bytes = vec![0xFFu8]; // misalign
        bytes.extend(values.iter().flat_map(|v| v.to_le_bytes()));
        assert!(try_cast_column::<u32>(&bytes, 1, 2).is_none());
    }
}
