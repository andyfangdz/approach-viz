//! wasm-bindgen surface of the weather edge Worker.
//!
//! The Worker owns I/O (R2 reads, caching, HTTP); everything that decides what
//! bytes a response holds — query validation, the query window, which pack
//! ranges to read, decoding, and AVMR/AVET encoding — runs here through the
//! same core code the runtime uses.

use std::io::Write;

use approach_viz_core::mrms_pack::{self, ByteRange, ScanPackIndex};
use approach_viz_core::mrms_query::{self, WeatherQuery};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

/// Decoded voxels a volume query may touch. A Worker isolate has 128 MB for
/// JS and WASM together, and WASM memory never shrinks. The heaviest window
/// of a busy CONUS scan (220 nm, 4.85M decoded voxels) peaked at 72 MB of
/// WASM memory, ~15 bytes per voxel, so this budget keeps WASM near 90 MB.
/// Larger windows are refused before any data is fetched and the web proxy
/// falls back to the runtime.
const MAX_WINDOW_VOXELS: f64 = 6_000_000.0;

/// Level 1 is ~5x faster than the level 6 of the platform `CompressionStream`
/// on a 15 MB payload for ~15% more bytes, and gzipping here means the
/// uncompressed payload never has to be copied into the JS heap.
const RESPONSE_GZIP_LEVEL: u32 = 1;

fn gzip(payload: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(payload.len() / 4),
        flate2::Compression::new(RESPONSE_GZIP_LEVEL),
    );
    encoder
        .write_all(payload)
        .expect("in-memory gzip cannot fail");
    encoder.finish().expect("in-memory gzip cannot fail")
}

/// The ranges' bytes, appended in order as each read completes so the JS
/// side never holds a concatenated copy.
#[wasm_bindgen]
pub struct RangeData {
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl RangeData {
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: usize) -> RangeData {
        RangeData {
            bytes: Vec::with_capacity(capacity),
        }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }
}

/// Header length of a pack, from its first 12 bytes.
#[wasm_bindgen(js_name = readHeaderLength)]
pub fn read_header_length(prefix: &[u8]) -> Result<u32, JsError> {
    mrms_pack::read_header_len(prefix).map_err(js_error)
}

/// A normalized query. Construction fails with the 400 message for invalid input.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct Query {
    inner: WeatherQuery,
}

#[wasm_bindgen]
impl Query {
    #[wasm_bindgen(js_name = volume)]
    pub fn volume(
        lat: f64,
        lon: f64,
        min_dbz: Option<f64>,
        max_range_nm: Option<f64>,
    ) -> Result<Query, JsError> {
        mrms_query::normalize_volume_query(lat, lon, min_dbz, max_range_nm)
            .map(|inner| Query { inner })
            .map_err(JsError::new)
    }

    #[wasm_bindgen(js_name = echoTops)]
    pub fn echo_tops(lat: f64, lon: f64, max_range_nm: Option<f64>) -> Result<Query, JsError> {
        mrms_query::normalize_echo_top_query(lat, lon, max_range_nm)
            .map(|inner| Query { inner })
            .map_err(JsError::new)
    }

    /// Stable text form of the normalized parameters, for cache keys.
    #[wasm_bindgen(js_name = cacheKey)]
    pub fn cache_key(&self) -> String {
        let q = self.inner;
        format!(
            "lat={}&lon={}&minDbz={}&maxRangeNm={}",
            q.lat, q.lon, q.min_dbz, q.max_range_nm
        )
    }
}

/// A parsed pack header.
#[wasm_bindgen]
pub struct ScanPack {
    index: ScanPackIndex,
}

fn flatten(ranges: impl IntoIterator<Item = ByteRange>) -> Vec<f64> {
    ranges
        .into_iter()
        .flat_map(|range| [range.offset as f64, range.len as f64])
        .collect()
}

fn flatten_headers(headers: &[(String, String)]) -> Vec<String> {
    headers
        .iter()
        .flat_map(|(name, value)| [name.clone(), value.clone()])
        .collect()
}

#[wasm_bindgen]
impl ScanPack {
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8]) -> Result<ScanPack, JsError> {
        ScanPackIndex::parse(header)
            .map(|index| ScanPack { index })
            .map_err(js_error)
    }

    #[wasm_bindgen(getter)]
    pub fn timestamp(&self) -> String {
        self.index.timestamp.clone()
    }

    #[wasm_bindgen(getter, js_name = totalLength)]
    pub fn total_length(&self) -> f64 {
        self.index.total_len as f64
    }

    /// `[name0, value0, name1, value1, ...]`
    #[wasm_bindgen(js_name = volumeHeaders)]
    pub fn volume_headers(&self) -> Vec<String> {
        flatten_headers(&self.index.volume_headers)
    }

    /// `[name0, value0, name1, value1, ...]`
    #[wasm_bindgen(js_name = echoTopHeaders)]
    pub fn echo_top_headers(&self) -> Vec<String> {
        flatten_headers(&self.index.echo_top_headers)
    }

    fn window(&self, query: &Query) -> mrms_query::QueryWindow {
        let q = query.inner;
        self.index
            .query_window(q.lat, q.lon, q.min_dbz, q.max_range_nm)
    }

    /// Whether a volume query fits the edge memory budget.
    #[wasm_bindgen(js_name = volumeWithinBudget)]
    pub fn volume_within_budget(&self, query: &Query) -> bool {
        (self.index.volume_voxel_count(&self.window(query)) as f64) <= MAX_WINDOW_VOXELS
    }

    /// Pack ranges a volume query reads, as `[offset0, length0, ...]`.
    #[wasm_bindgen(js_name = volumeRanges)]
    pub fn volume_ranges(&self, query: &Query) -> Vec<f64> {
        flatten(self.index.volume_ranges(&self.window(query)))
    }

    /// Gzipped AVMR v5 payload from the bytes of `volumeRanges`.
    #[wasm_bindgen(js_name = buildVolumeGzip)]
    pub fn build_volume_gzip(&self, query: &Query, data: RangeData) -> Result<Vec<u8>, JsError> {
        if !self.volume_within_budget(query) {
            return Err(JsError::new("volume window exceeds the edge memory budget"));
        }
        let window = self.window(query);
        let collector = self
            .index
            .collect_volume(&window, &data.bytes)
            .map_err(js_error)?;
        // The fetched chunks are decoded; free them before merging, which is
        // where the rest of the query's memory goes.
        drop(data);
        Ok(gzip(&collector.finish()))
    }

    /// Pack ranges an echo-top query reads, as `[offset0, length0, ...]`.
    #[wasm_bindgen(js_name = echoTopRanges)]
    pub fn echo_top_ranges(&self, query: &Query) -> Vec<f64> {
        flatten(self.index.echo_top_range(&self.window(query)))
    }

    /// Gzipped AVET v3 payload from the bytes of `echoTopRanges`.
    #[wasm_bindgen(js_name = buildEchoTopsGzip)]
    pub fn build_echo_tops_gzip(&self, query: &Query, data: RangeData) -> Result<Vec<u8>, JsError> {
        let payload = self
            .index
            .build_echo_tops(&self.window(query), &data.bytes)
            .map_err(js_error)?;
        Ok(gzip(&payload))
    }
}
