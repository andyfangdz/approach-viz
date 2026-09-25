//! wasm-bindgen surface of the web server routes (`app/api/...`).
//!
//! The routes own I/O (R2 reads, upstream fetches, HTTP); everything that
//! decides what bytes a response holds runs here through the same core code
//! the runtime uses:
//! - weather: query validation, windowing, scan-pack range planning, decoding,
//!   and AVMR/AVET encoding (`mrms_query`, `mrms_pack`);
//! - traffic: query parsing, binCraft decoding, current-aircraft selection,
//!   and AVTR encoding for the direct ADS-B fallback (`traffic_query`).

use approach_viz_core::mrms_pack::{self, ByteRange, ScanPackIndex};
use approach_viz_core::mrms_query::{self, WeatherQuery};
use approach_viz_core::traffic_query::{self, RawTrafficQuery, TrafficQuery as ParsedTrafficQuery};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

/// Header length of a scan pack, from its first 12 bytes.
#[wasm_bindgen(js_name = readHeaderLength)]
pub fn read_header_length(prefix: &[u8]) -> Result<u32, JsError> {
    mrms_pack::read_header_len(prefix).map_err(js_error)
}

/// A normalized weather query. Construction fails with the 400 message.
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
}

/// A parsed scan pack header.
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

    /// Pack ranges a volume query reads, as `[offset0, length0, ...]`.
    #[wasm_bindgen(js_name = volumeRanges)]
    pub fn volume_ranges(&self, query: &Query) -> Vec<f64> {
        flatten(self.index.volume_ranges(&self.window(query)))
    }

    /// AVMR v5 payload from the concatenated bytes of `volumeRanges`.
    #[wasm_bindgen(js_name = buildVolume)]
    pub fn build_volume(&self, query: &Query, data: &[u8]) -> Result<Vec<u8>, JsError> {
        self.index
            .build_volume(&self.window(query), data)
            .map_err(js_error)
    }

    /// Pack ranges an echo-top query reads, as `[offset0, length0, ...]`.
    #[wasm_bindgen(js_name = echoTopRanges)]
    pub fn echo_top_ranges(&self, query: &Query) -> Vec<f64> {
        flatten(self.index.echo_top_range(&self.window(query)))
    }

    /// AVET v3 payload from the bytes of `echoTopRanges`.
    #[wasm_bindgen(js_name = buildEchoTops)]
    pub fn build_echo_tops(&self, query: &Query, data: &[u8]) -> Result<Vec<u8>, JsError> {
        self.index
            .build_echo_tops(&self.window(query), data)
            .map_err(js_error)
    }
}

/// A parsed `/v1/traffic/adsbx` query. Construction fails with the 400 message.
#[wasm_bindgen]
pub struct TrafficQuery {
    inner: ParsedTrafficQuery,
}

#[wasm_bindgen]
impl TrafficQuery {
    #[wasm_bindgen(constructor)]
    pub fn new(
        lat: Option<String>,
        lon: Option<String>,
        radius_nm: Option<String>,
        limit: Option<String>,
        history_minutes: Option<String>,
        hide_ground: Option<String>,
        history_hexes: Option<String>,
    ) -> Result<TrafficQuery, JsError> {
        traffic_query::parse_traffic_query(RawTrafficQuery {
            lat: lat.as_deref(),
            lon: lon.as_deref(),
            radius_nm: radius_nm.as_deref(),
            limit: limit.as_deref(),
            history_minutes: history_minutes.as_deref(),
            hide_ground: hide_ground.as_deref(),
            history_hexes: history_hexes.as_deref(),
        })
        .map(|inner| TrafficQuery { inner })
        .map_err(|message| JsError::new(&message))
    }

    /// The tar1090 `/re-api/?binCraft&zstd&box=` value covering this query.
    #[wasm_bindgen(js_name = boxParam)]
    pub fn box_param(&self) -> String {
        let q = &self.inner;
        traffic_query::box_param(traffic_query::build_bounding_box(q.lat, q.lon, q.radius_nm))
    }

    /// AVTR v4 payload answering this query from one zstd-decompressed
    /// binCraft snapshot polled at `polled_at_ms` (current aircraft only).
    #[wasm_bindgen(js_name = buildDirectPayload)]
    pub fn build_direct_payload(
        &self,
        decoded_bincraft: &[u8],
        polled_at_ms: f64,
        source: &str,
    ) -> Result<Vec<u8>, JsError> {
        traffic_query::build_direct_traffic_payload(
            decoded_bincraft,
            &self.inner,
            polled_at_ms as i64,
            source,
        )
        .map_err(|message| JsError::new(&message))
    }
}
