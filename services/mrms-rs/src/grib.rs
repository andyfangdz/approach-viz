use std::io::{Cursor, Read};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;

use crate::types::{GridDef, PackedValues, ParsedField, ParsedPacking};
use crate::utils::to_lon360;

pub fn parse_grib_gzipped(zipped: &[u8]) -> Result<ParsedField> {
    let mut decoder = GzDecoder::new(Cursor::new(zipped));
    let mut grib = Vec::new();
    decoder
        .read_to_end(&mut grib)
        .context("Failed to gunzip GRIB payload")?;
    parse_grib(&grib)
}

fn parse_grib(buffer: &[u8]) -> Result<ParsedField> {
    if buffer.len() < 20 {
        bail!("MRMS GRIB payload is too small");
    }
    if &buffer[0..4] != b"GRIB" {
        bail!("MRMS payload does not start with GRIB bytes");
    }

    let mut pointer = 16_usize;
    let mut grid: Option<GridDef> = None;
    let mut packing: Option<ParsedPacking> = None;
    let mut bitmap_indicator: u8 = 255;
    let mut section7_data: Option<Vec<u8>> = None;

    while pointer + 5 <= buffer.len() {
        if pointer + 4 <= buffer.len() && &buffer[pointer..pointer + 4] == b"7777" {
            break;
        }

        let section_length = read_u32_be(buffer, pointer)? as usize;
        let section_number = *buffer
            .get(pointer + 4)
            .ok_or_else(|| anyhow!("Invalid GRIB section header"))?;

        if section_length < 5 || pointer + section_length > buffer.len() {
            bail!("Invalid GRIB section length {section_length} at offset {pointer}");
        }

        match section_number {
            3 => {
                let template_number = read_u16_be(buffer, pointer + 12)?;
                if template_number != 0 {
                    bail!("Unsupported MRMS grid template {template_number}");
                }

                let nx = read_u32_be(buffer, pointer + 30)?;
                let ny = read_u32_be(buffer, pointer + 34)?;
                let la1_deg = read_grib_signed_scaled_int32(buffer, pointer + 46)?;
                let lo1_deg360 = to_lon360(read_grib_signed_scaled_int32(buffer, pointer + 50)?);
                let di_deg = read_u32_be(buffer, pointer + 63)? as f64 / 1_000_000.0;
                let dj_deg = read_u32_be(buffer, pointer + 67)? as f64 / 1_000_000.0;
                let scanning_mode = *buffer
                    .get(pointer + 71)
                    .ok_or_else(|| anyhow!("Missing scanning mode byte"))?;

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

                grid = Some(GridDef {
                    nx,
                    ny,
                    la1_deg,
                    lo1_deg360,
                    di_deg,
                    dj_deg,
                    scanning_mode,
                    lat_step_deg: lat_step,
                    lon_step_deg: lon_step,
                });
            }
            5 => {
                let template_number = read_u16_be(buffer, pointer + 9)?;
                if template_number != 41 {
                    bail!("Unsupported MRMS data template {template_number}");
                }

                let data_point_count = read_u32_be(buffer, pointer + 5)? as usize;
                let reference_value = read_f32_be(buffer, pointer + 11)? as f64;
                let binary_scale_factor = read_i16_be(buffer, pointer + 15)?;
                let decimal_scale_factor = read_i16_be(buffer, pointer + 17)?;
                let _bits_per_value = *buffer
                    .get(pointer + 19)
                    .ok_or_else(|| anyhow!("Missing bits-per-value byte"))?;

                packing = Some(ParsedPacking {
                    reference_value,
                    binary_scale_factor,
                    decimal_scale_factor,
                    data_point_count,
                });
            }
            6 => {
                bitmap_indicator = *buffer
                    .get(pointer + 5)
                    .ok_or_else(|| anyhow!("Missing bitmap indicator byte"))?;
            }
            7 => {
                section7_data = Some(buffer[pointer + 5..pointer + section_length].to_vec());
            }
            _ => {}
        }

        pointer += section_length;
    }

    let grid = grid.ok_or_else(|| anyhow!("GRIB section 3 missing"))?;
    let packing = packing.ok_or_else(|| anyhow!("GRIB section 5 missing"))?;
    let section7_data = section7_data.ok_or_else(|| anyhow!("GRIB section 7 missing"))?;

    if bitmap_indicator != 255 {
        bail!("Unsupported bitmap indicator {bitmap_indicator}");
    }

    let decoder = png::Decoder::new(Cursor::new(section7_data));
    let mut reader = decoder.read_info().context("Failed to read PNG info")?;
    let output_size = reader
        .output_buffer_size()
        .ok_or_else(|| anyhow!("PNG output buffer size is unknown"))?;
    let mut png_buffer = vec![0_u8; output_size];
    let frame_info = reader
        .next_frame(&mut png_buffer)
        .context("Failed to decode PNG payload")?;

    if frame_info.width != grid.nx || frame_info.height != grid.ny {
        bail!(
            "Grid mismatch: GRIB {}x{}, PNG {}x{}",
            grid.nx,
            grid.ny,
            frame_info.width,
            frame_info.height
        );
    }

    let values = match frame_info.bit_depth {
        png::BitDepth::Eight => {
            let used = &png_buffer[..frame_info.buffer_size()];
            PackedValues::U8(used.to_vec())
        }
        png::BitDepth::Sixteen => {
            let used = &png_buffer[..frame_info.buffer_size()];
            if used.len() % 2 != 0 {
                bail!("Unexpected 16-bit PNG buffer length");
            }
            let mut decoded = Vec::with_capacity(used.len() / 2);
            let mut idx = 0;
            while idx + 1 < used.len() {
                decoded.push(u16::from_be_bytes([used[idx], used[idx + 1]]));
                idx += 2;
            }
            PackedValues::U16(decoded)
        }
        bit_depth => {
            bail!("Unsupported PNG bit depth {bit_depth:?}");
        }
    };

    if values.len() != packing.data_point_count {
        bail!(
            "Data-point mismatch: section5={}, decoded={}",
            packing.data_point_count,
            values.len()
        );
    }

    Ok(ParsedField {
        grid,
        packing,
        values,
    })
}

fn read_u16_be(buffer: &[u8], offset: usize) -> Result<u16> {
    if offset + 2 > buffer.len() {
        bail!("Out-of-range u16 read at {offset}");
    }
    Ok(u16::from_be_bytes([buffer[offset], buffer[offset + 1]]))
}

fn read_i16_be(buffer: &[u8], offset: usize) -> Result<i16> {
    if offset + 2 > buffer.len() {
        bail!("Out-of-range i16 read at {offset}");
    }
    Ok(i16::from_be_bytes([buffer[offset], buffer[offset + 1]]))
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

fn read_f32_be(buffer: &[u8], offset: usize) -> Result<f32> {
    if offset + 4 > buffer.len() {
        bail!("Out-of-range f32 read at {offset}");
    }
    Ok(f32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

fn read_grib_signed_scaled_int32(buffer: &[u8], offset: usize) -> Result<f64> {
    let raw = read_u32_be(buffer, offset)?;
    let sign = if (raw & 0x8000_0000) != 0 { -1.0 } else { 1.0 };
    let magnitude = (raw & 0x7fff_ffff) as f64;
    Ok(sign * magnitude / 1_000_000.0)
}
