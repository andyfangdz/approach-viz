//! Builders for tiny synthetic MRMS-style GRIB2 messages used by the decoder and
//! pipeline tests: real header sections (identification, grid, product) taken
//! from an MRMS CONUS file, patched to a small grid, plus a PNG-packed data
//! section (template 5.41, no bitmap) built from caller-supplied samples.

use std::io::Write;

use flate2::Compression;
use flate2::write::GzEncoder;

/// Section 1 (identification) of a real MRMS message.
const SECTION1: &str = "000000150100a10000ff010307ea0917140e2a0207";
/// Section 3 (template 3.0 lat/lon grid) of a real MRMS message.
const SECTION3: &str = "0000004803000175d720000000000201006128ee01006152b0010060ff2700001b5800000dac00000001000f4240034728380db59908300131408811e18f78000027100000271000";
/// Section 4 (template 4.0 product definition) of a real MRMS message.
const SECTION4: &str = "00000022040000000009000800610000000000000000660000000bb8ff0100000000";

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// GRIB2 signed integers are sign-magnitude.
pub fn sign_magnitude(value: i32) -> [u8; 2] {
    let bytes = (value.unsigned_abs() as u16).to_be_bytes();
    if value < 0 {
        [bytes[0] | 0x80, bytes[1]]
    } else {
        bytes
    }
}

pub fn section5(points: usize, template: u16, r: f32, e: i32, d: i32, bits: u8) -> Vec<u8> {
    let mut s = 21u32.to_be_bytes().to_vec();
    s.push(5);
    s.extend_from_slice(&(points as u32).to_be_bytes());
    s.extend_from_slice(&template.to_be_bytes());
    s.extend_from_slice(&r.to_be_bytes());
    s.extend_from_slice(&sign_magnitude(e));
    s.extend_from_slice(&sign_magnitude(d));
    s.push(bits);
    s.push(0);
    s
}

pub fn section6(indicator: u8) -> Vec<u8> {
    let mut s = 6u32.to_be_bytes().to_vec();
    s.push(6);
    s.push(indicator);
    s
}

pub fn png_bytes(width: u32, height: u32, sample_bytes: usize, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    match sample_bytes {
        1 => {
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
        }
        2 => {
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Sixteen);
        }
        _ => {
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
        }
    }
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(data).unwrap();
    writer.finish().unwrap();
    out
}

pub fn section7(png: &[u8]) -> Vec<u8> {
    let mut s = ((png.len() + 5) as u32).to_be_bytes().to_vec();
    s.push(7);
    s.extend_from_slice(png);
    s
}

/// Wraps sections in a GRIB2 indicator and end marker.
pub fn message(sections: &[&[u8]]) -> Vec<u8> {
    let body: usize = sections.iter().map(|section| section.len()).sum();
    let total = (16 + body + 4) as u64;
    let mut m = b"GRIB\0\0\0\x02".to_vec();
    m.extend_from_slice(&total.to_be_bytes());
    for section in sections {
        m.extend_from_slice(section);
    }
    m.extend_from_slice(b"7777");
    m
}

/// How a field's integer samples map to values: `(r + sample * 2^e) * 10^-d`.
#[derive(Clone, Copy)]
pub struct Packing {
    pub r: f32,
    pub e: i32,
    pub d: i32,
    /// 8, 16 or 24.
    pub bits: u8,
}

pub const REFLECTIVITY: Packing = Packing {
    r: -9990.0,
    e: 0,
    d: 1,
    bits: 16,
};
pub const ZDR: Packing = Packing {
    r: -9990.0,
    e: 0,
    d: 1,
    bits: 16,
};
pub const RHOHV: Packing = Packing {
    r: -99900.0,
    e: 0,
    d: 2,
    bits: 24,
};
pub const PRECIP_FLAG: Packing = Packing {
    r: -3.0,
    e: 0,
    d: 0,
    bits: 8,
};
pub const HEIGHT_METERS: Packing = Packing {
    r: -3.0,
    e: 0,
    d: 0,
    bits: 16,
};
pub const RQI: Packing = Packing {
    r: -30.0,
    e: 0,
    d: 1,
    bits: 8,
};
pub const ECHO_TOP_KM: Packing = Packing {
    r: -3000.0,
    e: 0,
    d: 3,
    bits: 16,
};

/// A complete single-field MRMS-style GRIB2 message on an `ni` x `nj` grid, with
/// the same georeferencing as the CONUS grid. `samples[i]` is the integer sample
/// of grid point `i`.
pub fn grib_field(ni: u32, nj: u32, packing: Packing, samples: &[u32]) -> Vec<u8> {
    let points = (ni * nj) as usize;
    assert_eq!(samples.len(), points);
    let width = (packing.bits / 8) as usize;
    let mut raw = Vec::with_capacity(points * width);
    for &sample in samples {
        raw.extend_from_slice(&sample.to_be_bytes()[4 - width..]);
    }

    let mut sect3 = hex(SECTION3);
    sect3[6..10].copy_from_slice(&(points as u32).to_be_bytes());
    sect3[30..34].copy_from_slice(&ni.to_be_bytes());
    sect3[34..38].copy_from_slice(&nj.to_be_bytes());

    let png = png_bytes(ni, nj, width, &raw);
    message(&[
        &hex(SECTION1),
        &sect3,
        &hex(SECTION4),
        &section5(points, 41, packing.r, packing.e, packing.d, packing.bits),
        &section6(255),
        &section7(&png),
    ])
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
