pub use approach_viz_core::traffic_query::encode_traffic_fb;
use approach_viz_core::traffic_query::TRAFFIC_FB_CONTENT_TYPE;

use super::types::{
    add_traffic_snapshot_headers, no_store_headers_with_content_type, TrafficBinaryPayload,
};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub(crate) fn traffic_binary_response(payload: TrafficBinaryPayload) -> Response {
    let bytes = encode_traffic_fb(&payload);
    let mut headers = no_store_headers_with_content_type(TRAFFIC_FB_CONTENT_TYPE);
    add_traffic_snapshot_headers(
        &mut headers,
        payload.stale_current,
        payload.snapshot_age_ms,
    );
    (StatusCode::OK, headers, bytes).into_response()
}
