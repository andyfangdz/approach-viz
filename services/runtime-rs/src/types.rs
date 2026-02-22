use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, Semaphore};

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: Client,
    pub latest: Arc<RwLock<Option<Arc<ScanSnapshot>>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingIngest>>>,
    pub recent_timestamps: Arc<Mutex<HashSet<String>>>,
    pub traffic_cache: Arc<RwLock<TrafficCacheState>>,
    pub ingest_parse_limiter: Arc<Semaphore>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrafficCacheState {
    pub updated_at_ms: i64,
    pub source: Option<String>,
    pub tracks_by_hex: HashMap<String, TrafficCacheTrack>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrafficCacheTrack {
    pub hex: String,
    pub flight: Option<String>,
    pub is_on_ground: bool,
    pub altitude_feet: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub track_deg: Option<f64>,
    pub last_observed_at_ms: i64,
    pub points: VecDeque<TrafficCachePoint>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct TrafficCachePoint {
    pub timestamp_ms: i64,
    pub lat: f64,
    pub lon: f64,
    pub altitude_feet: f64,
    pub is_on_ground: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LevelBounds {
    pub bottom_feet: u16,
    pub top_feet: u16,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StoredVoxel {
    pub row: u16,
    pub col: u16,
    pub level_idx: u8,
    pub phase: u8,
    pub surface_phase: u8, // from PrecipFlag_00.00, 0=rain, 1=mixed, 2=snow
    pub dbz_tenths: i16,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StoredEchoTop {
    pub row: u16,
    pub col: u16,
    pub top18_feet: u16,
    pub top30_feet: u16,
    pub top50_feet: u16,
    pub top60_feet: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GridDef {
    pub nx: u32,
    pub ny: u32,
    pub la1_deg: f64,
    pub lo1_deg360: f64,
    pub di_deg: f64,
    pub dj_deg: f64,
    pub scanning_mode: u8,
    pub lat_step_deg: f64,
    pub lon_step_deg: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanSnapshot {
    pub timestamp: String,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub grid: GridDef,
    pub tile_size: u16,
    pub tile_cols: u16,
    pub tile_rows: u16,
    pub level_bounds: Vec<LevelBounds>,
    pub tile_offsets: Vec<u32>,
    pub voxels: Vec<StoredVoxel>,
    #[serde(default)]
    pub echo_tops: Vec<StoredEchoTop>,
    #[serde(default)]
    pub echo_top_debug: EchoTopDebugMetadata,
    #[serde(default)]
    pub phase_debug: PhaseDebugMetadata,
}

#[derive(Clone, Debug)]
pub struct PendingIngest {
    pub attempts: u32,
    pub next_attempt_at: Instant,
}

#[derive(Clone, Debug)]
pub struct ParsedReflectivityField {
    pub grid: GridDef,
    pub dbz_tenths: Vec<i16>,
}

#[derive(Clone, Debug)]
pub struct ParsedAuxField {
    pub grid: GridDef,
    pub values: Vec<f32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PhaseDebugMetadata {
    pub mode: String,
    pub detail: String,
    pub zdr_timestamp: Option<String>,
    pub rhohv_timestamp: Option<String>,
    pub precip_flag_timestamp: Option<String>,
    pub freezing_level_timestamp: Option<String>,
    pub zdr_age_seconds: Option<i64>,
    pub rhohv_age_seconds: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EchoTopDebugMetadata {
    pub top18_timestamp: Option<String>,
    pub top30_timestamp: Option<String>,
    pub top50_timestamp: Option<String>,
    pub top60_timestamp: Option<String>,
    pub max_top18_feet: Option<u16>,
    pub max_top30_feet: Option<u16>,
    pub max_top50_feet: Option<u16>,
    pub max_top60_feet: Option<u16>,
}
