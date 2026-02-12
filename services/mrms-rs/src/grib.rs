use std::io::{Cursor, Read};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use grib::{Grib2SubmessageDecoder, GridDefinitionTemplateValues};

use crate::types::{GridDef, ParsedAuxField, ParsedReflectivityField};
use crate::utils::to_lon360;

pub fn parse_reflectivity_grib_gzipped(zipped: &[u8]) -> Result<ParsedReflectivityField> {
    let (grid, values) = parse_grib_gzipped_values(zipped)?;
    let dbz_tenths = values.into_iter().map(float_to_tenths).collect();
    Ok(ParsedReflectivityField { grid, dbz_tenths })
}

pub fn parse_aux_grib_gzipped(zipped: &[u8]) -> Result<ParsedAuxField> {
    let (grid, values) = parse_grib_gzipped_values(zipped)?;
    Ok(ParsedAuxField { grid, values })
}

fn parse_grib_gzipped_values(zipped: &[u8]) -> Result<(GridDef, Vec<f32>)> {
    let mut decoder = GzDecoder::new(Cursor::new(zipped));
    let mut grib = Vec::new();
    decoder
        .read_to_end(&mut grib)
        .context("Failed to gunzip GRIB payload")?;
    parse_grib_values(&grib)
}

fn parse_grib_values(buffer: &[u8]) -> Result<(GridDef, Vec<f32>)> {
    if buffer.len() < 20 {
        bail!("MRMS GRIB payload is too small");
    }
    if &buffer[0..4] != b"GRIB" {
        bail!("MRMS payload does not start with GRIB bytes");
    }

    let grib2 = grib::from_reader(Cursor::new(buffer.to_vec()))
        .map_err(|error| anyhow!("Failed to parse GRIB2 stream: {error}"))?;

    let mut submessages = grib2.iter();
    let (_, first_submessage) = submessages
        .next()
        .ok_or_else(|| anyhow!("No GRIB2 submessage found in payload"))?;

    let grid = grid_from_submessage(&first_submessage)?;
    let expected_count = grid.nx as usize * grid.ny as usize;

    let decoder = Grib2SubmessageDecoder::from(first_submessage)
        .map_err(|error| anyhow!("Failed to initialize GRIB2 submessage decoder: {error}"))?;
    let decoded = decoder
        .dispatch()
        .map_err(|error| anyhow!("Failed to decode GRIB2 values: {error}"))?;
    let values: Vec<f32> = decoded.collect();

    if values.len() != expected_count {
        bail!(
            "Decoded point-count mismatch: expected {}, got {}",
            expected_count,
            values.len()
        );
    }

    Ok((grid, values))
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

fn float_to_tenths(value: f32) -> i16 {
    if !value.is_finite() {
        return i16::MIN;
    }
    (f64::from(value) * 10.0)
        .round()
        .clamp(i16::MIN as f64, i16::MAX as f64) as i16
}
