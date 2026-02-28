use std::io::{Cursor, Read};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use grib::{Grib2SubmessageDecoder, GridDefinitionTemplateValues};
use wide::f32x4;

use crate::types::{GridDef, ParsedAuxField, ParsedReflectivityField};
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
    let (grid, expected_count, decoder) = prepare_grib_decoder(buffer)?;
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
    let (grid, expected_count, decoder) = prepare_grib_decoder(buffer)?;
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

    Ok(ParsedAuxField { grid, values })
}

fn prepare_grib_decoder(buffer: &[u8]) -> Result<(GridDef, usize, Grib2SubmessageDecoder)> {
    if buffer.len() < 20 {
        bail!("MRMS GRIB payload is too small");
    }
    if &buffer[0..4] != b"GRIB" {
        bail!("MRMS payload does not start with GRIB bytes");
    }

    let grib2 = grib::from_reader(Cursor::new(buffer))
        .map_err(|error| anyhow!("Failed to parse GRIB2 stream: {error}"))?;

    let mut submessages = grib2.iter();
    let (_, first_submessage) = submessages
        .next()
        .ok_or_else(|| anyhow!("No GRIB2 submessage found in payload"))?;

    let grid = grid_from_submessage(&first_submessage)?;
    let expected_count = grid.nx as usize * grid.ny as usize;

    let decoder = Grib2SubmessageDecoder::from(first_submessage)
        .map_err(|error| anyhow!("Failed to initialize GRIB2 submessage decoder: {error}"))?;

    Ok((grid, expected_count, decoder))
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
