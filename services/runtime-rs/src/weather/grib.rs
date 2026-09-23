use std::io::{Cursor, Read};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use grib::{Grib2SubmessageDecoder, GridDefinitionTemplateValues};
use wide::f32x4;

use crate::types::{
    packed_sample_value, AuxValues, GridDef, PackedSamples, ParsedAuxField, ParsedReflectivityField,
};
use crate::utils::to_lon360;

const MAX_GZIP_ISIZE_HINT_BYTES: usize = 64 * 1024 * 1024;

pub fn parse_reflectivity_grib_gzipped(zipped: &[u8]) -> Result<ParsedReflectivityField> {
    let grib = gunzip_grib_payload(zipped)?;
    parse_reflectivity_grib_values(&grib)
}

pub fn parse_aux_grib_gzipped(zipped: &[u8]) -> Result<ParsedAuxField> {
    let grib = gunzip_grib_payload(zipped)?;
    parse_aux_grib_values(&grib)
}

fn gunzip_grib_payload(zipped: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = GzDecoder::new(Cursor::new(zipped));
    let mut grib = Vec::with_capacity(gzip_isize_hint(zipped));
    decoder
        .read_to_end(&mut grib)
        .context("Failed to gunzip GRIB payload")?;
    Ok(grib)
}

fn gzip_isize_hint(zipped: &[u8]) -> usize {
    if zipped.len() < 4 {
        return 0;
    }
    let trailer_offset = zipped.len() - 4;
    let isize = u32::from_le_bytes([
        zipped[trailer_offset],
        zipped[trailer_offset + 1],
        zipped[trailer_offset + 2],
        zipped[trailer_offset + 3],
    ]) as usize;
    if isize == 0 || isize > MAX_GZIP_ISIZE_HINT_BYTES {
        0
    } else {
        isize
    }
}

fn parse_reflectivity_grib_values(buffer: &[u8]) -> Result<ParsedReflectivityField> {
    let grib2 = open_grib(buffer)?;
    let (_, first_submessage) = grib2
        .iter()
        .next()
        .ok_or_else(|| anyhow!("No GRIB2 submessage found in payload"))?;
    let grid = grid_from_submessage(&first_submessage)?;
    let expected_count = grid.nx as usize * grid.ny as usize;

    if let Some(packed) = PackedPngField::locate(buffer, expected_count) {
        let dbz_tenths = packed.decode_tenths()?;
        return Ok(ParsedReflectivityField { grid, dbz_tenths });
    }

    let decoder = Grib2SubmessageDecoder::from(first_submessage)
        .map_err(|error| anyhow!("Failed to initialize GRIB2 submessage decoder: {error}"))?;
    let decoded = decoder
        .dispatch()
        .map_err(|error| anyhow!("Failed to decode GRIB2 values: {error}"))?;

    let mut raw_f32: Vec<f32> = Vec::with_capacity(expected_count);
    raw_f32.extend(decoded);

    if raw_f32.len() != expected_count {
        bail!(
            "Decoded point-count mismatch: expected {}, got {}",
            expected_count,
            raw_f32.len()
        );
    }

    let dbz_tenths = floats_to_tenths_bulk(&raw_f32);

    Ok(ParsedReflectivityField { grid, dbz_tenths })
}

fn parse_aux_grib_values(buffer: &[u8]) -> Result<ParsedAuxField> {
    let grib2 = open_grib(buffer)?;
    let (_, first_submessage) = grib2
        .iter()
        .next()
        .ok_or_else(|| anyhow!("No GRIB2 submessage found in payload"))?;
    let grid = grid_from_submessage(&first_submessage)?;
    let expected_count = grid.nx as usize * grid.ny as usize;

    if let Some(packed) = PackedPngField::locate(buffer, expected_count) {
        let values = packed.decode_packed()?;
        return Ok(ParsedAuxField { grid, values });
    }

    let decoder = Grib2SubmessageDecoder::from(first_submessage)
        .map_err(|error| anyhow!("Failed to initialize GRIB2 submessage decoder: {error}"))?;
    let decoded = decoder
        .dispatch()
        .map_err(|error| anyhow!("Failed to decode GRIB2 values: {error}"))?;

    let mut values = Vec::with_capacity(expected_count);
    values.extend(decoded);

    if values.len() != expected_count {
        bail!(
            "Decoded point-count mismatch: expected {}, got {}",
            expected_count,
            values.len()
        );
    }

    Ok(ParsedAuxField {
        grid,
        values: AuxValues::Dense(values),
    })
}

fn open_grib(
    buffer: &[u8],
) -> Result<grib::Grib2<grib::SeekableGrib2Reader<Cursor<&[u8]>>>> {
    if buffer.len() < 20 {
        bail!("MRMS GRIB payload is too small");
    }
    if &buffer[0..4] != b"GRIB" {
        bail!("MRMS payload does not start with GRIB bytes");
    }

    grib::from_reader(Cursor::new(buffer))
        .map_err(|error| anyhow!("Failed to parse GRIB2 stream: {error}"))
}

/// A GRIB2 field packed with data-representation template 5.41 (PNG) and no
/// bitmap — the layout every MRMS product uses.
///
/// The `grib` crate decodes these through a per-element iterator chain (bit
/// extraction, bitmap check and two `powi` calls per grid point), which costs
/// ~190 ms for a 24.5M-point CONUS field. Here the PNG is inflated once and the
/// integer samples are mapped with the same `f32` arithmetic the crate applies
/// (`(R + X * 2^E) * 10^-D`): through a lookup table for 8/16-bit samples and
/// directly for 24-bit samples. The results are bit-identical to the crate's;
/// anything this path does not recognize falls back to the crate decoder.
struct PackedPngField<'a> {
    ref_val: f32,
    exp: i32,
    dec: i32,
    sample_bytes: usize,
    point_count: usize,
    png: &'a [u8],
}

impl<'a> PackedPngField<'a> {
    /// Walks the GRIB2 sections of the first message and returns the packed
    /// field when it uses template 5.41 with a whole-byte sample width, no
    /// bitmap, and exactly `expected_points` encoded values.
    fn locate(buffer: &'a [u8], expected_points: usize) -> Option<Self> {
        const INDICATOR_LEN: usize = 16;
        let (mut sect5, mut sect6, mut sect7) = (None, None, None);
        let mut pos = INDICATOR_LEN;
        while pos + 5 <= buffer.len() && &buffer[pos..pos + 4] != b"7777" {
            let len = u32::from_be_bytes(buffer[pos..pos + 4].try_into().ok()?) as usize;
            let number = buffer[pos + 4];
            let end = pos.checked_add(len)?;
            if len < 5 || end > buffer.len() {
                return None;
            }
            let section = &buffer[pos..end];
            let slot = match number {
                5 => &mut sect5,
                6 => &mut sect6,
                7 => &mut sect7,
                _ => {
                    pos = end;
                    continue;
                }
            };
            // A repeated data section means a multi-field message; leave it
            // to the crate decoder.
            if slot.replace(section).is_some() {
                return None;
            }
            pos = end;
        }
        let (sect5, sect6, sect7): (&[u8], &[u8], &[u8]) = (sect5?, sect6?, sect7?);

        // Section 5, octets 6-9 point count, 10-11 template, 12-15 R,
        // 16-17 E, 18-19 D, 20 bits per value, 21 original field type.
        if sect5.len() < 21 || u16::from_be_bytes([sect5[9], sect5[10]]) != 41 {
            return None;
        }
        let point_count = u32::from_be_bytes(sect5[5..9].try_into().ok()?) as usize;
        let ref_val = f32::from_be_bytes(sect5[11..15].try_into().ok()?);
        let exp = grib_signed_i16(sect5[15], sect5[16]);
        let dec = grib_signed_i16(sect5[17], sect5[18]);
        let sample_bytes = match sect5[19] {
            8 => 1,
            16 => 2,
            24 => 3,
            _ => return None,
        };
        // Type of original field values: 0 is floating point, the only kind
        // the crate decoder accepts.
        if sect5[20] != 0 {
            return None;
        }
        // Section 6 indicator 255: no bitmap applies.
        if sect6.len() < 6 || sect6[5] != 255 {
            return None;
        }
        if point_count != expected_points {
            return None;
        }

        Some(Self {
            ref_val,
            exp,
            dec,
            sample_bytes,
            point_count,
            png: &sect7[5..],
        })
    }

    fn inflate_samples(&self) -> Result<Vec<u8>> {
        let mut reader = png::Decoder::new(Cursor::new(self.png))
            .read_info()
            .map_err(|error| anyhow!("Failed to decode GRIB2 values: PNG decode error: {error}"))?;
        let buf_size = reader.output_buffer_size().ok_or_else(|| {
            anyhow!("Failed to decode GRIB2 values: PNG decode error: Getting output buffer size failed")
        })?;
        let mut samples = vec![0; buf_size];
        reader
            .next_frame(&mut samples)
            .map_err(|error| anyhow!("Failed to decode GRIB2 values: PNG decode error: {error}"))?;

        let available = samples.len() / self.sample_bytes;
        if available < self.point_count {
            bail!(
                "Decoded point-count mismatch: expected {}, got {}",
                self.point_count,
                available
            );
        }
        samples.truncate(self.point_count * self.sample_bytes);
        Ok(samples)
    }

    /// The crate's per-sample conversion, applied to one integer sample.
    #[inline]
    fn scale(&self, pow2: f32, dig_factor: f32, sample: u32) -> f32 {
        packed_sample_value(self.ref_val, pow2, dig_factor, sample)
    }

    fn factors(&self) -> (f32, f32) {
        (2_f32.powi(self.exp), 10_f32.powi(-self.dec))
    }

    /// Lookup table over every possible 8/16-bit sample value.
    fn f32_lut(&self) -> Vec<f32> {
        let (pow2, dig_factor) = self.factors();
        let entries = 1usize << (self.sample_bytes * 8);
        (0..entries)
            .map(|sample| self.scale(pow2, dig_factor, sample as u32))
            .collect()
    }

    /// Keeps the inflated samples and defers conversion to access time.
    fn decode_packed(&self) -> Result<AuxValues> {
        let samples = self.inflate_samples()?;
        let packed = if self.sample_bytes == 3 {
            let (pow2, dig_factor) = self.factors();
            PackedSamples::with_linear(samples, 3, self.ref_val, pow2, dig_factor)
        } else {
            PackedSamples::with_table(samples, self.sample_bytes, self.f32_lut())
        };
        Ok(AuxValues::Packed(packed))
    }

    /// Dense conversion of every sample.
    fn decode_f32(&self) -> Result<Vec<f32>> {
        let samples = self.inflate_samples()?;
        let out = match self.sample_bytes {
            1 => {
                let lut = self.f32_lut();
                samples.iter().map(|&s| lut[s as usize]).collect()
            }
            2 => {
                let lut = self.f32_lut();
                samples
                    .chunks_exact(2)
                    .map(|c| lut[u16::from_be_bytes([c[0], c[1]]) as usize])
                    .collect()
            }
            _ => {
                let (pow2, dig_factor) = self.factors();
                samples
                    .chunks_exact(3)
                    .map(|c| {
                        let sample = u32::from(c[0]) << 16 | u32::from(c[1]) << 8 | u32::from(c[2]);
                        self.scale(pow2, dig_factor, sample)
                    })
                    .collect()
            }
        };
        Ok(out)
    }

    /// Reflectivity in tenths of dBZ. The 8/16-bit lookup table is converted
    /// with `floats_to_tenths_bulk`, so the mapping is the production one.
    fn decode_tenths(&self) -> Result<Vec<i16>> {
        if self.sample_bytes == 3 {
            return Ok(floats_to_tenths_bulk(&self.decode_f32()?));
        }
        let samples = self.inflate_samples()?;
        let lut = floats_to_tenths_bulk(&self.f32_lut());
        let out = if self.sample_bytes == 1 {
            samples.iter().map(|&s| lut[s as usize]).collect()
        } else {
            samples
                .chunks_exact(2)
                .map(|c| lut[u16::from_be_bytes([c[0], c[1]]) as usize])
                .collect()
        };
        Ok(out)
    }
}

/// GRIB2 stores signed integers as sign and magnitude.
fn grib_signed_i16(high: u8, low: u8) -> i32 {
    let magnitude = i32::from(u16::from_be_bytes([high & 0x7f, low]));
    if high & 0x80 != 0 {
        -magnitude
    } else {
        magnitude
    }
}

fn grid_from_submessage<R>(submessage: &grib::SubMessage<'_, R>) -> Result<GridDef> {
    let grid_definition = submessage.grid_def();
    let template = GridDefinitionTemplateValues::try_from(grid_definition)
        .map_err(|error| anyhow!("Unsupported GRIB2 grid definition: {error}"))?;

    let latlon = match template {
        GridDefinitionTemplateValues::Template0(definition) => definition,
        _ => bail!("Unsupported GRIB2 grid template (expected template 3.0)"),
    };

    let payload: Vec<u8> = grid_definition.iter().copied().collect();
    if payload.len() < 66 {
        bail!("GRIB2 Section 3 payload is too short: {}", payload.len());
    }

    // Template 3.0 stores directional increments at octets 64-67 and 68-71
    // (1-based section coordinates), which are payload offsets 58 and 62.
    let di_deg = read_u32_be(&payload, 58)? as f64 / 1_000_000.0;
    let dj_deg = read_u32_be(&payload, 62)? as f64 / 1_000_000.0;

    let scanning_mode = latlon.scanning_mode.0;
    let lat_step = if scanning_mode & 0x40 == 0 {
        -dj_deg.abs()
    } else {
        dj_deg.abs()
    };
    let lon_step = if scanning_mode & 0x80 == 0 {
        di_deg.abs()
    } else {
        -di_deg.abs()
    };

    Ok(GridDef {
        nx: latlon.ni,
        ny: latlon.nj,
        la1_deg: latlon.first_point_lat as f64 / 1_000_000.0,
        lo1_deg360: to_lon360(latlon.first_point_lon as f64 / 1_000_000.0),
        di_deg,
        dj_deg,
        scanning_mode,
        lat_step_deg: lat_step,
        lon_step_deg: lon_step,
    })
}

fn read_u32_be(buffer: &[u8], offset: usize) -> Result<u32> {
    if offset + 4 > buffer.len() {
        bail!("Out-of-range u32 read at {offset}");
    }
    Ok(u32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

/// Bulk-convert f32 values to i16 tenths using f32 arithmetic.
///
/// Non-finite values map to `i16::MIN`. Uses `(value * 10.0).round()` in f32
/// which is precise for the MRMS reflectivity range (−999.0 to +999.0 dBZ).
fn floats_to_tenths_bulk(values: &[f32]) -> Vec<i16> {
    let n = values.len();
    let mut out = vec![i16::MIN; n];
    let scale = f32x4::splat(10.0);
    let lo = f32x4::splat(i16::MIN as f32);
    let hi = f32x4::splat(i16::MAX as f32);
    let chunks = n / 4;

    let src_chunks: &[[f32; 4]] = bytemuck::cast_slice(&values[..chunks * 4]);
    let dst_chunks: &mut [[i16; 4]] = bytemuck::cast_slice_mut(&mut out[..chunks * 4]);

    for i in 0..chunks {
        let v = f32x4::from(src_chunks[i]);
        let finite = v.is_finite();
        let scaled = (v * scale).round().max(lo).min(hi);
        // Blend: finite → scaled, non-finite → i16::MIN (already in output)
        let result = finite.blend(scaled, f32x4::splat(i16::MIN as f32));
        let arr = result.to_array();
        dst_chunks[i] = [
            arr[0] as i16,
            arr[1] as i16,
            arr[2] as i16,
            arr[3] as i16,
        ];
    }

    // Scalar tail
    for i in (chunks * 4)..n {
        let v = values[i];
        if v.is_finite() {
            out[i] = (v * 10.0).round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weather::testkit::{
        self, gzip, message, png_bytes, section5, section6, section7,
    };

    /// Deterministic samples covering both ends of the range and a spread of
    /// values in between.
    fn samples(points: usize, sample_bytes: usize) -> Vec<u8> {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut bytes = Vec::with_capacity(points * sample_bytes);
        for i in 0..points {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let word = (state >> 24) as u32;
            let value = match i {
                0 => 0,
                1 => u32::MAX,
                2 => 1,
                _ => word,
            };
            let be = value.to_be_bytes();
            bytes.extend_from_slice(&be[4 - sample_bytes..]);
        }
        bytes
    }

    fn sample_words(points: usize, sample_bytes: usize) -> Vec<u32> {
        samples(points, sample_bytes)
            .chunks_exact(sample_bytes)
            .map(|chunk| chunk.iter().fold(0u32, |acc, &byte| acc << 8 | u32::from(byte)))
            .collect()
    }

    const PARAMS: [(f32, i32, i32); 7] = [
        (-9990.0, 0, 1),
        (-99900.0, 0, 2),
        (-3.0, 0, 0),
        (-3000.0, 0, 3),
        (0.5, -2, -1),
        (1.0e-3, 3, 4),
        (-32.25, 1, 2),
    ];

    /// The `grib` crate's own decode of a complete message: the reference the
    /// fast path must reproduce exactly.
    fn crate_values(buffer: &[u8]) -> Vec<f32> {
        let grib2 = open_grib(buffer).unwrap();
        let (_, first) = grib2.iter().next().unwrap();
        Grib2SubmessageDecoder::from(first)
            .unwrap()
            .dispatch()
            .unwrap()
            .collect()
    }

    fn assert_bit_identical(actual: &[f32], expected: &[f32], context: &str) {
        assert_eq!(actual.len(), expected.len(), "{context}");
        for (i, (a, b)) in actual.iter().zip(expected).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "{context}: mismatch at {i}: {a} vs {b}");
        }
    }

    #[test]
    fn packed_decode_matches_grib_crate_bit_for_bit() {
        let (width, height) = (64u32, 33u32);
        let points = (width * height) as usize;
        for sample_bytes in [1usize, 2, 3] {
            for (r, e, d) in PARAMS {
                let raw = samples(points, sample_bytes);
                let png = png_bytes(width, height, sample_bytes, &raw);
                let sect5 = section5(points, 41, r, e, d, (sample_bytes * 8) as u8);
                let sect6 = section6(255);
                let sect7 = section7(&png);

                let expected: Vec<f32> =
                    Grib2SubmessageDecoder::new(points, sect5.clone(), sect6.clone(), sect7.clone())
                        .unwrap()
                        .dispatch()
                        .unwrap()
                        .collect();

                let msg = message(&[&sect5, &sect6, &sect7]);
                let packed = PackedPngField::locate(&msg, points)
                    .unwrap_or_else(|| panic!("locate failed for bytes={sample_bytes} r={r}"));
                let context = format!("bytes={sample_bytes} r={r} e={e} d={d}");

                assert_bit_identical(&packed.decode_f32().unwrap(), &expected, &context);
                assert_bit_identical(
                    &packed.decode_packed().unwrap().to_vec(),
                    &expected,
                    &context,
                );
                assert_eq!(
                    packed.decode_tenths().unwrap(),
                    floats_to_tenths_bulk(&expected),
                    "tenths mismatch {context}"
                );
            }
        }
    }

    #[test]
    fn locate_declines_layouts_it_does_not_own() {
        let (width, height) = (8u32, 4u32);
        let points = 32usize;
        let raw = samples(points, 2);
        let sect7 = section7(&png_bytes(width, height, 2, &raw));
        let good5 = section5(points, 41, -3.0, 0, 0, 16);
        let good6 = section6(255);

        let ok = message(&[&good5, &good6, &sect7]);
        assert!(PackedPngField::locate(&ok, points).is_some());

        // Not PNG packing (template 5.0 simple packing).
        let simple = message(&[&section5(points, 0, -3.0, 0, 0, 16), &good6, &sect7]);
        assert!(PackedPngField::locate(&simple, points).is_none());

        // A bitmap applies.
        let bitmap = message(&[&good5, &section6(0), &sect7]);
        assert!(PackedPngField::locate(&bitmap, points).is_none());

        // Point count disagrees with the grid.
        assert!(PackedPngField::locate(&ok, points + 1).is_none());

        // Unsupported sample width.
        let odd_width = message(&[&section5(points, 41, -3.0, 0, 0, 12), &good6, &sect7]);
        assert!(PackedPngField::locate(&odd_width, points).is_none());

        // Multi-field message repeats the data sections.
        let repeated = message(&[&good5, &good6, &sect7, &good5, &good6, &sect7]);
        assert!(PackedPngField::locate(&repeated, points).is_none());

        // Missing data section.
        let truncated = message(&[&good5, &good6]);
        assert!(PackedPngField::locate(&truncated, points).is_none());
    }

    #[test]
    fn packed_decode_reports_short_image_as_count_mismatch() {
        let raw = samples(16, 2);
        let sect7 = section7(&png_bytes(4, 4, 2, &raw));
        let msg = message(&[&section5(32, 41, -3.0, 0, 0, 16), &section6(255), &sect7]);
        let packed = PackedPngField::locate(&msg, 32).unwrap();
        let error = packed.decode_f32().unwrap_err().to_string();
        assert!(error.contains("Decoded point-count mismatch"), "{error}");
    }

    #[test]
    fn parse_entry_points_match_the_grib_crate_on_full_messages() {
        let (ni, nj) = (48u32, 20u32);
        let points = (ni * nj) as usize;
        for (name, packing) in [
            ("reflectivity", testkit::REFLECTIVITY),
            ("rhohv", testkit::RHOHV),
            ("precip flag", testkit::PRECIP_FLAG),
            ("height", testkit::HEIGHT_METERS),
        ] {
            let words = sample_words(points, (packing.bits / 8) as usize);
            let message = testkit::grib_field(ni, nj, packing, &words);
            let zipped = gzip(&message);
            let expected = crate_values(&message);

            let aux = parse_aux_grib_gzipped(&zipped).unwrap();
            assert_eq!((aux.grid.nx, aux.grid.ny), (ni, nj), "{name}");
            assert_bit_identical(&aux.values.to_vec(), &expected, name);
            assert!(matches!(aux.values, AuxValues::Packed(_)), "{name} should use the fast path");

            let reflectivity = parse_reflectivity_grib_gzipped(&zipped).unwrap();
            assert_eq!((reflectivity.grid.nx, reflectivity.grid.ny), (ni, nj), "{name}");
            assert_eq!(reflectivity.dbz_tenths, floats_to_tenths_bulk(&expected), "{name}");
        }
    }

    #[test]
    fn grid_definition_is_read_from_the_message() {
        let words = vec![9000u32; 8 * 4];
        let message = testkit::grib_field(8, 4, testkit::REFLECTIVITY, &words);
        let parsed = parse_reflectivity_grib_gzipped(&gzip(&message)).unwrap();
        let grid = parsed.grid;
        assert_eq!((grid.nx, grid.ny), (8, 4));
        assert!((grid.la1_deg - 54.995).abs() < 1e-6, "{}", grid.la1_deg);
        assert!((grid.lo1_deg360 - 230.005).abs() < 1e-6, "{}", grid.lo1_deg360);
        assert!((grid.di_deg - 0.01).abs() < 1e-9 && (grid.dj_deg - 0.01).abs() < 1e-9);
        assert!(grid.lat_step_deg < 0.0 && grid.lon_step_deg > 0.0);
    }

    #[test]
    fn bitmap_messages_fall_back_to_the_grib_crate() {
        // 32 grid points, every one present in the bitmap.
        let (ni, nj) = (8u32, 4u32);
        let points = (ni * nj) as usize;
        let words: Vec<u32> = (0..points as u32).map(|i| 10_040 + i * 3).collect();
        let full = testkit::grib_field(ni, nj, testkit::REFLECTIVITY, &words);

        // Rebuild the same message with section 6 carrying an all-ones bitmap.
        let mut bitmap = 10u32.to_be_bytes().to_vec();
        bitmap.extend_from_slice(&[6, 0, 0xff, 0xff, 0xff, 0xff]);
        let mut parts: Vec<Vec<u8>> = Vec::new();
        let mut pos = 16;
        while &full[pos..pos + 4] != b"7777" {
            let len = u32::from_be_bytes(full[pos..pos + 4].try_into().unwrap()) as usize;
            let number = full[pos + 4];
            parts.push(if number == 6 { bitmap.clone() } else { full[pos..pos + len].to_vec() });
            pos += len;
        }
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        let with_bitmap = message(&refs);
        assert!(PackedPngField::locate(&with_bitmap, points).is_none());

        let via_bitmap = parse_aux_grib_gzipped(&gzip(&with_bitmap)).unwrap();
        assert!(matches!(via_bitmap.values, AuxValues::Dense(_)));
        let via_fast = parse_aux_grib_gzipped(&gzip(&full)).unwrap();
        assert_bit_identical(&via_bitmap.values.to_vec(), &via_fast.values.to_vec(), "bitmap fallback");

        let tenths = parse_reflectivity_grib_gzipped(&gzip(&with_bitmap)).unwrap().dbz_tenths;
        assert_eq!(tenths, parse_reflectivity_grib_gzipped(&gzip(&full)).unwrap().dbz_tenths);
    }

    #[test]
    fn corrupt_payloads_fail_loudly() {
        assert!(parse_aux_grib_gzipped(&gzip(b"not a grib message at all, just text")).is_err());
        assert!(parse_reflectivity_grib_gzipped(b"definitely not gzip").is_err());
    }
}
